import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { DEMO_ASSUMPTIONS, demoResolutionState } from '@/lib/assumptions-demo'
import {
  buildLineItemUpdate,
  allAssumptionsResolved,
  shouldRecordAssumptionAsResolved,
  resolveQuoteStatusAfterTransitionAttempt,
} from '@/lib/assumption-resolution'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ResolveInput {
  assumption_id: string
  resolution: 'accepted' | 'adjusted' | 'excluded'
  adjusted_quantity?: number
  adjusted_unit?: string
  builder_id: string
  // Learning-engine capture (migration 069) — optional, never required.
  // No UI passes this yet; the field exists so a future "why did you
  // change this?" prompt has somewhere to land without a second migration.
  reason?: string
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

  const { assumption_id, resolution, adjusted_quantity, adjusted_unit, reason } = body

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
      .select('id, job_id')
      .eq('id', quoteId)
      .eq('builder_id', builder_id)
      .single()
    if (!ownedQuote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    // 1. Read the assumption (not yet a write) — ownership/existence check,
    // and gives us line_item_id before deciding what order to write in.
    //
    // Invariant this route must uphold: assumptions.resolution_type must
    // never say "resolved" while the linked quote_line_items row still
    // represents the old/unresolved value. supabase-js has no real
    // multi-table transaction available here, and assumptions.resolution_type
    // has a DB CHECK constraint that only allows
    // 'accepted'|'adjusted'|'excluded' (no room for a "pending"/"failed"
    // value without a migration, which this fix deliberately avoids) — so
    // the invariant is enforced by ORDERING instead: the quote_line_items
    // write happens first and is confirmed successful (see
    // shouldRecordAssumptionAsResolved) before assumptions.resolution_type
    // is ever written. If the line-item write fails, the assumption is
    // simply never marked resolved — it stays exactly as it was (a genuine,
    // pre-existing "unresolved" state, safe to retry, not a new state
    // machine) rather than reporting a false success.
    const { data: assumptionRow, error: assumptionReadErr } = await supabase
      .from('assumptions')
      .select('id, quote_id, line_item_id, resolution_type')
      .eq('id', assumption_id)
      .eq('quote_id', quoteId)
      .single()

    if (assumptionReadErr || !assumptionRow) {
      return NextResponse.json(
        { error: assumptionReadErr?.message ?? 'Assumption not found' },
        { status: 404 }
      )
    }

    // 2. Update linked quote_line_items row FIRST — see the invariant note
    // above. lineItemWriteOutcome is null when there's no linked line item
    // at all (nothing to wait on before recording the resolution).
    let lineItemWriteOutcome: { error: { message: string } | null } | null = null

    if (assumptionRow.line_item_id) {
      // Learning-engine capture (migration 069): the AI-predicted values as
      // they stand right now, before this resolution overwrites them —
      // fetched together with the existing rate lookup below rather than a
      // second round trip.
      let priorQuantity: number | null = null
      let priorUnit: string | null = null
      let priorTradeCategoryId: number | null = null
      let priorRate: number | null = null

      if (resolution === 'adjusted') {
        const { data: lineItem } = await supabase
          .from('quote_line_items')
          .select('rate, quantity, unit, trade_category_id')
          .eq('id', assumptionRow.line_item_id)
          .single()

        priorQuantity = lineItem?.quantity ?? null
        priorUnit = lineItem?.unit ?? null
        priorTradeCategoryId = lineItem?.trade_category_id ?? null
        priorRate = lineItem?.rate ?? null
      }

      const lineItemUpdate = buildLineItemUpdate(resolution, {
        adjustedQuantity: adjusted_quantity,
        adjustedUnit: adjusted_unit,
        priorRate,
      })

      const { error: lineItemWriteErr } = await supabase
        .from('quote_line_items')
        .update(lineItemUpdate)
        .eq('id', assumptionRow.line_item_id)

      lineItemWriteOutcome = { error: lineItemWriteErr ? { message: lineItemWriteErr.message } : null }

      if (lineItemWriteErr) {
        console.error('[assumptions/resolve] quote_line_items update failed — assumption will NOT be recorded as resolved:', lineItemWriteErr.message)
      } else {
        // Learning-engine capture (migration 069) — only for genuine
        // corrections, and only the field(s) that actually changed. A Gate 1
        // item with priorQuantity/priorUnit both null still gets a row: "AI
        // had nothing, builder supplied X" is exactly the kind of gap the
        // learning engine exists to notice, not a value to skip recording.
        // Best-effort — a capture failure must never break the resolution
        // it's describing.
        if (resolution === 'adjusted' && priorTradeCategoryId !== null) {
          try {
            const correctionRows: Array<Record<string, unknown>> = []
            if (adjusted_quantity !== undefined && adjusted_quantity !== priorQuantity) {
              correctionRows.push({
                job_id: ownedQuote.job_id, quote_id: quoteId, quote_line_item_id: assumptionRow.line_item_id,
                trade_category_id: priorTradeCategoryId, field: 'quantity',
                ai_predicted: priorQuantity === null ? null : String(priorQuantity),
                human_corrected: String(adjusted_quantity), reason: reason ?? null, corrected_by: builder_id,
              })
            }
            if (adjusted_unit !== undefined && adjusted_unit !== priorUnit) {
              correctionRows.push({
                job_id: ownedQuote.job_id, quote_id: quoteId, quote_line_item_id: assumptionRow.line_item_id,
                trade_category_id: priorTradeCategoryId, field: 'unit',
                ai_predicted: priorUnit, human_corrected: adjusted_unit, reason: reason ?? null, corrected_by: builder_id,
              })
            }
            if (correctionRows.length > 0) {
              const { data: inserted } = await supabase.from('estimator_corrections').insert(correctionRows).select('id')
              const lastCorrectionId = inserted?.[inserted.length - 1]?.id ?? null
              if (lastCorrectionId) {
                await supabase
                  .from('quote_line_items')
                  .update({ predicted_by: 'human', correction_id: lastCorrectionId })
                  .eq('id', assumptionRow.line_item_id)
              }
            }
          } catch (captureErr) {
            console.error('[assumptions/resolve] estimator_corrections capture failed:', captureErr)
          }
        }

        // If the item is still unpriced (e.g. Gate 1 — unit was missing and
        // has now been supplied), try to resolve a rate via the 5-tier
        // hierarchy. Best-effort: assumption_status/quantity/unit are already
        // correctly persisted at this point (the write above succeeded), so
        // a failure here leaves the item validly "still unpriced" — an
        // existing, gate-tracked state — rather than an inconsistency with
        // the assumption's resolution.
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
              const { error: rateWriteErr } = await supabase
                .from('quote_line_items')
                .update({
                  rate: priced.rate, total: priced.total,
                  pricing_source: priced.pricing_source, pricing_basis: priced.pricing_basis,
                })
                .eq('id', li.id)
              if (rateWriteErr) {
                console.error('[assumptions/resolve] rate-resolution write failed (best-effort, item stays unpriced):', rateWriteErr.message)
              }
            }
          }
        }

        // Recalculate quote totals from the current line items. (The previous
        // inline version used .neq('assumption_status', 'excluded'), which in
        // PostgREST also drops rows where the status is NULL — every normal
        // line item — so totals only counted assumption items.)
        const { recomputeQuoteTotals } = await import('@/lib/pricing')
        await recomputeQuoteTotals(supabase, quoteId)

        // Refresh the QA report so the review screen's "what to check" list
        // reflects this resolution immediately (e.g. a Gate-1 item that just
        // got a unit and a rate should drop out of the unpriced top-risk).
        // Best-effort — runQualityAssurance never throws.
        const { runQualityAssurance } = await import('@/lib/estimating/qa')
        await runQualityAssurance(supabase, quoteId, ownedQuote.job_id)
      }
    }

    // 3. Only now, once the linked line item (if any) is confirmed to
    // reflect this resolution, record assumptions.resolution_type — the
    // core invariant this fix exists to uphold. If the line-item write
    // failed, the assumption is left exactly as it was: not a new state,
    // safe to retry (a resubmission re-attempts the same, still-idempotent
    // line-item write).
    if (!shouldRecordAssumptionAsResolved(lineItemWriteOutcome)) {
      return NextResponse.json(
        { error: 'Failed to save the change to this line item — the assumption was not marked resolved. Please try again.' },
        { status: 500 }
      )
    }

    const { error: assumptionWriteErr } = await supabase
      .from('assumptions')
      .update({
        resolution_type: resolution,
        resolved_at: now,
        resolved_by: builder_id,
      })
      .eq('id', assumption_id)
      .eq('quote_id', quoteId)

    if (assumptionWriteErr) {
      // The line item (if any) already reflects the new value — only the
      // "resolved" bookkeeping failed. Safe to retry: a resubmission redoes
      // an idempotent line-item write (same values) and retries this write.
      console.error('[assumptions/resolve] assumptions resolution write failed:', assumptionWriteErr.message)
      return NextResponse.json(
        { error: 'The change was saved, but recording it as resolved failed — please try again.' },
        { status: 500 }
      )
    }

    // 4. Check if all assumptions for this quote are resolved. An assumption
    // whose line-item write just failed above never reached this point (the
    // route already returned), so it still reads as unresolved here — this
    // check can never advance the quote based on a false resolution.
    const { data: remaining } = await supabase
      .from('assumptions')
      .select('id, resolution_type')
      .eq('quote_id', quoteId)

    const allResolved = allAssumptionsResolved(remaining ?? [])

    let quoteStatus = 'draft'

    // 5. If all resolved → advance quote to pending_review (forward-only)
    if (allResolved) {
      const { data: quoteRow } = await supabase
        .from('quotes')
        .update({ status: 'pending_review' })
        .eq('id', quoteId)
        .eq('status', 'draft') // forward-only guard
        .select('status')
        .single()

      let currentActualStatus: string | null = null
      if (!quoteRow) {
        // 0 rows matched — either a genuine write failure, or this quote was
        // already advanced by an earlier/concurrent request. Those are NOT
        // the same thing; re-check the real value rather than assume either.
        const { data: currentQuote, error: currentQuoteErr } = await supabase
          .from('quotes')
          .select('status')
          .eq('id', quoteId)
          .single()
        if (currentQuoteErr) {
          console.error('[assumptions/resolve] could not re-check quote status after transition attempt:', currentQuoteErr.message)
        }
        currentActualStatus = currentQuote?.status ?? null
      }

      quoteStatus = resolveQuoteStatusAfterTransitionAttempt({ data: quoteRow ?? null }, currentActualStatus)
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
