import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { runInBackground } from '@/lib/run-background'
import { isValidTradeCategoryId } from '@/lib/trade-taxonomy'

// ─── PATCH /api/quotes/[quoteId]/line-items/[itemId] ─────────────────────────
//
// Three independent bodies, discriminated by which fields are present:
//
//   { rate: number }      — the original "unblock the unpriced-line-item
//                           gate" path. quantity != null → total = quantity
//                           × rate; quantity == null (PC/PS allowance) →
//                           total = rate, i.e. the figure is the lump
//                           amount. Unchanged from before manual line items
//                           existed.
//   { excluded: true }    — exclude the line from the quote entirely (same
//                           assumption_status = 'excluded' the resolution
//                           flow uses; totals recompute identically).
//   { description?, trade_category_id?, quantity?, unit?, rate? } — general
//                           edit (new). Any subset of fields; unset fields
//                           keep their current value. Works on any line item
//                           on a draft/pending_review quote, AI-generated or
//                           manually entered — one editing surface for the
//                           one canonical line-item structure, not a
//                           manual-only special case.
//
// Only quotes still in draft/pending_review can be touched — once a quote is
// sent, its line items are what the client saw and must stay auditable.

interface PatchBody {
  rate?: number
  excluded?: boolean
  description?: string
  trade_category_id?: number
  quantity?: number | null
  unit?: string | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { quoteId: string; itemId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  let body: PatchBody
  try {
    body = await req.json() as PatchBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const wantsExclude = body.excluded === true
  const wantsEdit =
    body.description !== undefined ||
    body.trade_category_id !== undefined ||
    body.quantity !== undefined ||
    body.unit !== undefined
  const wantsRate = !wantsEdit && body.rate !== undefined

  if (wantsExclude && (wantsEdit || body.rate !== undefined)) {
    return NextResponse.json({ error: 'excluded must be sent alone' }, { status: 400 })
  }
  if (!wantsExclude && !wantsEdit && !wantsRate) {
    return NextResponse.json({ error: 'Provide rate, excluded, or fields to edit' }, { status: 400 })
  }
  if (wantsRate && (typeof body.rate !== 'number' || !Number.isFinite(body.rate) || body.rate <= 0)) {
    return NextResponse.json({ error: 'rate must be a positive number' }, { status: 400 })
  }
  if (wantsEdit) {
    if (body.description !== undefined && (typeof body.description !== 'string' || !body.description.trim())) {
      return NextResponse.json({ error: 'description cannot be empty' }, { status: 400 })
    }
    if (body.trade_category_id !== undefined && !isValidTradeCategoryId(body.trade_category_id)) {
      return NextResponse.json({ error: 'trade_category_id must be a valid trade' }, { status: 400 })
    }
    if (body.quantity !== undefined && body.quantity !== null && (typeof body.quantity !== 'number' || !Number.isFinite(body.quantity) || body.quantity <= 0)) {
      return NextResponse.json({ error: 'quantity must be a positive number, or null' }, { status: 400 })
    }
    if (body.unit !== undefined && body.unit !== null && (typeof body.unit !== 'string' || !body.unit.trim())) {
      return NextResponse.json({ error: 'unit cannot be empty' }, { status: 400 })
    }
    if (body.rate !== undefined && (typeof body.rate !== 'number' || !Number.isFinite(body.rate) || body.rate <= 0)) {
      return NextResponse.json({ error: 'rate must be a positive number' }, { status: 400 })
    }
  }

  const { quoteId, itemId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Owner + status guard: line items on a sent/approved quote are the
    // audit record of what the client was shown — immutable here.
    const { data: quoteRow } = await supabase
      .from('quotes')
      .select('id, job_id, status')
      .eq('id', quoteId)
      .eq('builder_id', builderId)
      .single()
    if (!quoteRow) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }
    if (!['draft', 'pending_review'].includes(quoteRow.status)) {
      return NextResponse.json(
        { error: `Quote is ${quoteRow.status} — line items can no longer be changed` },
        { status: 422 }
      )
    }

    const { data: itemRow } = await supabase
      .from('quote_line_items')
      .select('id, description, trade_category_id, quantity, unit, rate')
      .eq('id', itemId)
      .eq('quote_id', quoteId)
      .single()
    if (!itemRow) {
      return NextResponse.json({ error: 'Line item not found on this quote' }, { status: 404 })
    }

    let update: Record<string, unknown>
    if (wantsExclude) {
      update = { assumption_status: 'excluded' }
    } else if (wantsEdit) {
      const mergedQuantity = body.quantity !== undefined ? body.quantity : itemRow.quantity
      const mergedRate = body.rate !== undefined ? body.rate : itemRow.rate
      update = {
        description: body.description !== undefined ? body.description!.trim() : itemRow.description,
        trade_category_id: body.trade_category_id !== undefined ? body.trade_category_id : itemRow.trade_category_id,
        quantity: mergedQuantity,
        unit: body.unit !== undefined ? (body.unit === null ? null : body.unit.trim()) : itemRow.unit,
        // Same total rule as the rate-only branch below: no rate → no total;
        // a lump-sum (PC/PS, no quantity) uses the rate itself as the total.
        total: mergedRate === null ? null : (mergedQuantity !== null ? round2(mergedQuantity * mergedRate) : round2(mergedRate)),
        // A human just edited this row, whatever it started as.
        predicted_by: 'human',
      }
      // Only stamp manual pricing provenance when the rate itself was part
      // of this edit — changing the description/quantity/unit shouldn't
      // silently overwrite an AI-resolved rate's own source label.
      if (body.rate !== undefined) {
        update.rate = mergedRate
        update.confidence = 100
        update.pricing_source = 'manual'
        update.pricing_basis = null
      }
    } else {
      update = {
        rate: body.rate,
        total: itemRow.quantity !== null
          ? round2(itemRow.quantity * body.rate!)
          : round2(body.rate!),
        // A builder-entered price is a direct answer, not an inference.
        confidence: 100,
        // Was previously unset here — the one pricing path (of document/
        // cost_rates_exact/normalized/category_rate/ai_measured_rate/
        // ai_allowance/manual/unresolved) that never wrote pricing_source
        // at all. pricing_basis cleared: a builder's own number needs no
        // AI-generated justification attached to it.
        pricing_source: 'manual',
        pricing_basis: null,
      }
    }

    const { error: updateErr } = await supabase
      .from('quote_line_items')
      .update(update)
      .eq('id', itemId)
      .eq('quote_id', quoteId)
    if (updateErr) {
      // quote_line_items_unique_per_quote (migration 030) — an edit that
      // changes description/trade into a combination that collides with
      // another line already on this quote.
      if (wantsEdit && (updateErr as { code?: string }).code === '23505') {
        return NextResponse.json(
          { error: 'An item with this description already exists for this trade — use a different description or edit the existing item.' },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    // Totals must be correct before this response returns — the response
    // itself doesn't include qa_report (confirmed: it never has), so QA can
    // safely run in the background (Background tier — see CLAUDE.md's
    // execution-tier documentation). The send gate never reads qa_report
    // anyway (it derives its own signals fresh), so a request racing ahead
    // of this background write can't see a stale-clear send gate either.
    const { recomputeQuoteTotals } = await import('@/lib/pricing')
    await recomputeQuoteTotals(supabase, quoteId)
    runInBackground('line_item_patch_quality_assurance', async () => {
      const { runQualityAssurance } = await import('@/lib/estimating/qa')
      await runQualityAssurance(supabase, quoteId, quoteRow.job_id)
    })

    return NextResponse.json({
      updated: true,
      item_id: itemId,
      action: wantsExclude ? 'excluded' : wantsEdit ? 'edited' : 'priced',
    })
  } catch (err) {
    console.error('[line-items:patch] error:', err)
    return NextResponse.json({ error: 'Failed to update line item — please try again.' }, { status: 500 })
  }
}

// ─── DELETE /api/quotes/[quoteId]/line-items/[itemId] ────────────────────────
//
// Removes a line item entirely — the "Delete" half of manual line-item
// management. Same owner + draft/pending_review guard as PATCH above.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { quoteId: string; itemId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  const { quoteId, itemId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: quoteRow } = await supabase
      .from('quotes')
      .select('id, job_id, status')
      .eq('id', quoteId)
      .eq('builder_id', builderId)
      .single()
    if (!quoteRow) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }
    if (!['draft', 'pending_review'].includes(quoteRow.status)) {
      return NextResponse.json(
        { error: `Quote is ${quoteRow.status} — line items can no longer be changed` },
        { status: 422 }
      )
    }

    const { data: itemRow } = await supabase
      .from('quote_line_items')
      .select('id')
      .eq('id', itemId)
      .eq('quote_id', quoteId)
      .single()
    if (!itemRow) {
      return NextResponse.json({ error: 'Line item not found on this quote' }, { status: 404 })
    }

    // assumptions.line_item_id has no ON DELETE clause (defaults to
    // RESTRICT) — an AI-extracted item with an open Gate 1/2 assumption
    // would otherwise fail this delete with a raw foreign-key error.
    // Detach the reference (keep the assumption row itself, same pattern
    // migration 030 already established) so any line item on a draft quote
    // can actually be deleted, not just manually-created ones.
    await supabase.from('assumptions').update({ line_item_id: null }).eq('line_item_id', itemId)

    const { error: deleteErr } = await supabase
      .from('quote_line_items')
      .delete()
      .eq('id', itemId)
      .eq('quote_id', quoteId)
    if (deleteErr) {
      return NextResponse.json({ error: deleteErr.message }, { status: 500 })
    }

    const { recomputeQuoteTotals } = await import('@/lib/pricing')
    await recomputeQuoteTotals(supabase, quoteId)
    runInBackground('line_item_delete_quality_assurance', async () => {
      const { runQualityAssurance } = await import('@/lib/estimating/qa')
      await runQualityAssurance(supabase, quoteId, quoteRow.job_id)
    })

    return NextResponse.json({ deleted: true, item_id: itemId })
  } catch (err) {
    console.error('[line-items:delete] error:', err)
    return NextResponse.json({ error: 'Failed to delete item — please try again.' }, { status: 500 })
  }
}
