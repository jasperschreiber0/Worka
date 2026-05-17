import { NextRequest, NextResponse } from 'next/server'
import { DEMO_ASSUMPTIONS, demoResolutionState } from '../route'

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

  const { assumption_id, resolution, adjusted_quantity, adjusted_unit, builder_id } = body

  if (!assumption_id || !resolution || !builder_id) {
    return NextResponse.json(
      { error: 'Missing required fields: assumption_id, resolution, builder_id' },
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

    // 1. Update assumptions table
    const { data: assumptionRow, error: assumptionErr } = await supabase
      .from('assumptions')
      .update({
        resolution_type: resolution,
        resolved_at: now,
        resolved_by: builder_id,
      })
      .eq('id', assumption_id)
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
    console.error('Assumptions resolve error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
