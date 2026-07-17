import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { DEMO_ASSUMPTIONS, demoResolutionState } from '@/lib/assumptions-demo'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResolveInput {
  assumption_id: string
  resolution: 'accepted' | 'adjusted' | 'excluded'
  adjusted_quantity?: number
  adjusted_unit?: string
  builder_id: string
}

interface ResolvedAssumption {
  id: string
  resolution_type: 'accepted' | 'adjusted' | 'excluded'
  resolved_at: string
  resolved_by: string
}

interface ResolveResponse {
  resolved: true
  assumption: ResolvedAssumption
  all_resolved: boolean
  quote_status: string
}

// ─── POST /api/assumptions/[quoteId]/resolve ──────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const { quoteId } = params

  let body: ResolveInput
  try {
    body = (await req.json()) as ResolveInput
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { assumption_id, resolution, adjusted_quantity, adjusted_unit } = body

  if (!assumption_id || !resolution) {
    return NextResponse.json(
      { error: 'Missing required fields: assumption_id, resolution' },
      { status: 400 }
    )
  }

  if (resolution === 'adjusted' && adjusted_quantity === undefined) {
    return NextResponse.json(
      { error: 'adjusted_quantity is required when resolution is "adjusted"' },
      { status: 400 }
    )
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isRealMode = Boolean(supabaseUrl && supabaseKey)

  // ── Demo mode ──────────────────────────────────────────────────────────────
  if (!isRealMode || quoteId === 'demo-quote-id') {
    const assumption = DEMO_ASSUMPTIONS.find((a) => a.id === assumption_id)
    if (!assumption) {
      return NextResponse.json({ error: 'Assumption not found' }, { status: 404 })
    }

    // Store resolution in module-level map
    demoResolutionState.set(assumption_id, {
      resolution_type: resolution,
      adjusted_quantity,
      adjusted_unit,
    })

    // Check if all demo assumptions are now resolved
    const allResolved = DEMO_ASSUMPTIONS.every((a) => {
      const state = demoResolutionState.get(a.id)
      return state !== undefined && state.resolution_type !== 'unresolved'
    })

    const quoteStatus = allResolved ? 'pending_review' : 'draft'

    const resolvedAssumption: ResolvedAssumption = {
      id: assumption_id,
      resolution_type: resolution,
      resolved_at: new Date().toISOString(),
      resolved_by: builder_id,
    }

    const response: ResolveResponse = {
      resolved: true,
      assumption: resolvedAssumption,
      all_resolved: allResolved,
      quote_status: quoteStatus,
    }

    return NextResponse.json(response)
  }

  // ── Real mode: Supabase ───────────────────────────────────────────────────
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(supabaseUrl!, supabaseKey!)

    const now = new Date().toISOString()

    // The quote must belong to the authenticated builder
    const { data: ownedQuote } = await supabase
      .from('quotes')
      .select('id, status')
      .eq('id', quoteId)
      .eq('builder_id', builder_id)
      .single()
    if (!ownedQuote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    // A sent quote's line items (and thus its total, and whatever a prior
    // risk_acknowledgement_snapshot described) must not change after the
    // client has received it — that's the one thing the whole Proof trail
    // exists to guarantee. Resolving an assumption here would silently
    // change quote_line_items/total_cost via recomputeQuoteTotals below with
    // no new acknowledgement and no Proof event. Use Revise to create a new
    // quote version, or a Variation for scope changes after the client has
    // already agreed to this one.
    if (ownedQuote.status !== 'draft' && ownedQuote.status !== 'pending_review') {
      return NextResponse.json(
        {
          error: `This quote is already ${ownedQuote.status} and can't be modified. Use "Revise" to create a new version, or record scope changes as a variation.`,
        },
        { status: 422 }
      )
    }

    // 1. Update assumptions table — constrained to this quote
    const { data: assumptionRow, error: assumptionErr } = await supabase
      .from('assumptions')
      .update({
        resolution_type: resolution,
        resolved_at: now,
        resolved_by: builder_id,
      })
      .eq('id', assumption_id)
      .eq('quote_id', quoteId)
      .select()
      .single()

    if (assumptionErr || !assumptionRow) {
      return NextResponse.json(
        { error: assumptionErr?.message ?? 'Assumption not found' },
        { status: 404 }
      )
    }

    // 2. Update linked quote_line_items row
    if (assumptionRow.line_item_id) {
      // Build the update payload
      const lineItemUpdate: Record<string, unknown> = {
        assumption_status: resolution,
      }

      if (resolution === 'adjusted') {
        lineItemUpdate.quantity = adjusted_quantity
        if (adjusted_unit !== undefined) {
          lineItemUpdate.unit = adjusted_unit
        }
        // Recalculate total if rate is known — fetch rate first
        const { data: lineItem } = await supabase
          .from('quote_line_items')
          .select('rate')
          .eq('id', assumptionRow.line_item_id)
          .single()

        if (lineItem?.rate && adjusted_quantity !== undefined) {
          lineItemUpdate.total = adjusted_quantity * lineItem.rate
        }
      }

      if (resolution === 'excluded') {
        lineItemUpdate.is_assumption = true
        lineItemUpdate.assumption_status = 'excluded'
      }

      await supabase
        .from('quote_line_items')
        .update(lineItemUpdate)
        .eq('id', assumptionRow.line_item_id)

      // If the item is still unpriced (e.g. Gate 1 — unit was missing and has
      // now been supplied), try to resolve a rate via the 5-tier hierarchy
      if (resolution !== 'excluded') {
        const { data: li } = await supabase
          .from('quote_line_items')
          .select('id, trade_category_id, description, quantity, unit, rate')
          .eq('id', assumptionRow.line_item_id)
          .single()

        if (li && li.rate === null && li.quantity !== null && li.unit) {
          const { data: builderRow } = await supabase
            .from('builders')
            .select('state')
            .eq('id', builder_id)
            .single()

          const { priceLineItems } = await import('@/lib/pricing')
          const [priced] = await priceLineItems(
            supabase,
            builder_id,
            builderRow?.state ?? null,
            [li]
          )

          if (priced.rate !== null) {
            await supabase
              .from('quote_line_items')
              .update({ rate: priced.rate, total: priced.total })
              .eq('id', li.id)
          }
        }
      }

      // Recalculate quote totals from the current line items. (The previous
      // inline version used .neq('assumption_status', 'excluded'), which in
      // PostgREST also drops rows where the status is NULL — every normal
      // line item — so totals only counted assumption items.)
      const { recomputeQuoteTotals } = await import('@/lib/pricing')
      await recomputeQuoteTotals(supabase, quoteId)
    }

    // 3. Check if all assumptions for this quote are resolved
    const { data: remaining } = await supabase
      .from('assumptions')
      .select('id, resolution_type')
      .eq('quote_id', quoteId)

    const allResolved =
      !!remaining &&
      remaining.every(
        (a) => a.resolution_type !== null && a.resolution_type !== 'unresolved'
      )

    let quoteStatus = 'draft'

    // 4. If all resolved → advance quote to pending_review (forward-only)
    if (allResolved) {
      const { data: quoteRow } = await supabase
        .from('quotes')
        .update({ status: 'pending_review' })
        .eq('id', quoteId)
        .eq('status', 'draft') // forward-only guard
        .select('status')
        .single()

      quoteStatus = quoteRow?.status ?? 'pending_review'
    }

    const resolvedAssumption: ResolvedAssumption = {
      id: assumption_id,
      resolution_type: resolution,
      resolved_at: now,
      resolved_by: builder_id,
    }

    const response: ResolveResponse = {
      resolved: true,
      assumption: resolvedAssumption,
      all_resolved: allResolved,
      quote_status: quoteStatus,
    }

    return NextResponse.json(response)
  } catch (err) {
    // Real mode was configured, so this is a genuine failure — surfacing it
    // as a demo-mode "success" would tell the builder an assumption was
    // resolved (and possibly the quote advanced to pending_review) when
    // nothing was actually written to the database.
    console.error('[assumptions/resolve] error:', err)
    return NextResponse.json({ error: 'Failed to resolve assumption — please try again.' }, { status: 500 })
  }
}
