import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { applyApprovedVariationToQuote } from '@/lib/variations'
import { canRetryContractApplication } from '@/lib/variation-approval'

// ─── POST /api/variations/[variationId]/retry-contract-application ───────────
//
// Builder-triggered repair for the one gap applyApprovedVariationToQuote's
// own error-checked, idempotent design doesn't close by itself: once a
// variation's status reaches 'approved' (forward-only — neither the client
// PATCH route nor the builder resolve route will ever attempt the contract
// application again for it), a failed attempt had no way to be retried
// through the product surface. This route is that retry — safe by
// construction: it re-checks the exact preconditions
// applyApprovedVariationToQuote's own idempotency guard (the
// quote_line_items_variation_id_unique constraint, migration 098) already
// relies on, so it can never create a duplicate line item, and a
// non-retryable reason (e.g. missing trade_category_id) is simply returned
// again — never looped automatically.

export async function POST(
  req: NextRequest,
  { params }: { params: { variationId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  const { variationId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: variation } = await supabase
      .from('variations')
      .select('id, job_id, builder_id, title, amount, status, trade_category_id')
      .eq('id', variationId)
      .eq('builder_id', builderId)
      .single()

    if (!variation) {
      return NextResponse.json({ error: 'Variation not found' }, { status: 404 })
    }

    const { data: existingLine } = await supabase
      .from('quote_line_items')
      .select('id')
      .eq('variation_id', variationId)
      .maybeSingle()

    if (!canRetryContractApplication(variation.status, Boolean(existingLine))) {
      if (variation.status !== 'approved') {
        return NextResponse.json(
          { error: `Variation is ${variation.status} — only an approved variation can retry its contract application.` },
          { status: 422 }
        )
      }
      // Already applied — not an error, just nothing to do.
      return NextResponse.json({ contract_effect: { applied: true, alreadyApplied: true, lineItemId: existingLine!.id } })
    }

    const contractEffect = await applyApprovedVariationToQuote(supabase, {
      id: variation.id,
      job_id: variation.job_id,
      title: variation.title,
      amount: variation.amount,
      trade_category_id: variation.trade_category_id,
    })

    if (!contractEffect.applied) {
      console.error(JSON.stringify({
        event: 'variation_contract_application_retry_failed',
        variation_id: variation.id, job_id: variation.job_id, reason: contractEffect.reason,
      }))
    }

    return NextResponse.json({ contract_effect: contractEffect })
  } catch (err) {
    console.error('[variations/retry-contract-application] error:', err)
    return NextResponse.json({ error: 'Failed to retry — please try again.' }, { status: 500 })
  }
}
