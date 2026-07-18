import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

// ─── PATCH /api/quotes/[quoteId]/line-items/[itemId] ─────────────────────────
//
// The unblock path for the unpriced-line-item gate. When a line item fails
// every pricing tier it has rate = null / total = null, contributes $0 to the
// quote, and (as of the readiness gate) blocks sending. This endpoint is the
// builder's way through: either supply the price themselves, or exclude the
// line from the quote. Nothing else about a line item is editable here —
// quantities/units stay the assumption-resolution flow's job, and descriptions
// are extraction output, not builder input.
//
// Deliberately narrow:
//   { rate: number }      — set the builder's own price for the line.
//                           quantity != null → total = quantity × rate;
//                           quantity == null (PC/PS allowance) → total = rate,
//                           i.e. the figure is the lump amount.
//   { excluded: true }    — exclude the line from the quote entirely (same
//                           assumption_status = 'excluded' the resolution
//                           flow uses; totals recompute identically).
//
// Only quotes still in draft/pending_review can be touched — once a quote is
// sent, its line items are what the client saw and must stay auditable.

interface PatchBody {
  rate?: number
  excluded?: boolean
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

  const wantsRate = body.rate !== undefined
  const wantsExclude = body.excluded === true
  if (wantsRate === wantsExclude) {
    return NextResponse.json({ error: 'Provide exactly one of: rate, excluded' }, { status: 400 })
  }
  if (wantsRate && (typeof body.rate !== 'number' || !Number.isFinite(body.rate) || body.rate <= 0)) {
    return NextResponse.json({ error: 'rate must be a positive number' }, { status: 400 })
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
      .select('id, quantity')
      .eq('id', itemId)
      .eq('quote_id', quoteId)
      .single()
    if (!itemRow) {
      return NextResponse.json({ error: 'Line item not found on this quote' }, { status: 404 })
    }

    const update: Record<string, unknown> = wantsExclude
      ? { assumption_status: 'excluded' }
      : {
          rate: body.rate,
          total: itemRow.quantity !== null
            ? round2(itemRow.quantity * body.rate!)
            : round2(body.rate!),
          // A builder-entered price is a direct answer, not an inference.
          confidence: 100,
        }

    const { error: updateErr } = await supabase
      .from('quote_line_items')
      .update(update)
      .eq('id', itemId)
      .eq('quote_id', quoteId)
    if (updateErr) {
      return NextResponse.json({ error: updateErr.message }, { status: 500 })
    }

    // Keep the money and the "what to check" list truthful immediately.
    const { recomputeQuoteTotals } = await import('@/lib/pricing')
    await recomputeQuoteTotals(supabase, quoteId)
    const { runQualityAssurance } = await import('@/lib/estimating/qa')
    await runQualityAssurance(supabase, quoteId, quoteRow.job_id)

    return NextResponse.json({ updated: true, item_id: itemId, action: wantsExclude ? 'excluded' : 'priced' })
  } catch (err) {
    console.error('[line-items:patch] error:', err)
    return NextResponse.json({ error: 'Failed to update line item — please try again.' }, { status: 500 })
  }
}
