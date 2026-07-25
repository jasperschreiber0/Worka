import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { DEMO_QUOTE } from '@/lib/quote-demo'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { recomputeQuoteTotals } from '@/lib/pricing'
import { getUnresolvedConservativeAssumptions } from '@/lib/estimating/readiness'
import { runInBackground } from '@/lib/run-background'

// ─── Request body ─────────────────────────────────────────────────────────────

// ─── Response shape ───────────────────────────────────────────────────────────

interface ReviseResponse {
  new_quote_id: string
  version: number
}

// ─── Route handler ────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { quoteId } = params

  if (isDemoMode() || quoteId === 'demo-quote-id') {
    // Demo mode: return a mock new version
    const newVersion = DEMO_QUOTE.version + 1
    const newQuoteId = `demo-quote-v${newVersion}-${Date.now()}`

    const response: ReviseResponse = {
      new_quote_id: newQuoteId,
      version: newVersion,
    }

    return NextResponse.json(response, { status: 201 })
  }

  // Real Supabase path: fetch the existing quote + line items, insert a new
  // quote row one version up, copy every line item across, and recompute
  // totals on the new quote.
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) {
    return NextResponse.json({ error: 'Not configured' }, { status: 503 })
  }

  const startedAt = Date.now()
  try {
    const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })

    const { data: existingQuote, error: quoteErr } = await supabase
      .from('quotes')
      .select('*')
      .eq('id', quoteId)
      .eq('builder_id', builderId)
      .single()

    if (quoteErr || !existingQuote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    const { data: existingItems, error: itemsErr } = await supabase
      .from('quote_line_items')
      .select('*')
      .eq('quote_id', quoteId)

    if (itemsErr) {
      console.error('[quotes/revise] line item fetch failed:', itemsErr.message)
      return NextResponse.json({ error: 'Failed to load quote line items' }, { status: 500 })
    }

    // Unresolved conservative assumptions (non-blocking-estimation defaults —
    // gate IS NULL AND line_item_id IS NULL distinguishes these from Gate 1-3
    // per-line assumptions, which are never touched here). Quote lifecycle
    // integrity fix: revise previously copied line items and qa_report but
    // never these rows, so a quote WorkA correctly refused to send (an
    // unresolved "blocking" clarifying question) could be revised into a
    // fresh draft with zero assumption rows — the send gate
    // (getSendBlockingReasons) would then find nothing to block on, even
    // though the underlying uncertainty was never actually resolved. Only
    // unresolved rows are copied — a resolved one carries no risk to
    // preserve, and re-copying it would just be dead weight on the new quote.
    const { data: unresolvedConservativeAssumptions, error: assumptionsErr } = await getUnresolvedConservativeAssumptions(supabase, quoteId, '*')

    if (assumptionsErr) {
      console.error('[quotes/revise] conservative assumption fetch failed:', assumptionsErr.message)
      return NextResponse.json({ error: 'Failed to load quote assumptions' }, { status: 500 })
    }

    const newVersion = (existingQuote.version ?? 1) + 1

    const {
      id: _oldId, created_at: _oldCreatedAt, sent_at: _sentAt, approved_at: _approvedAt,
      version: _oldVersion, status: _oldStatus,
      // Deliberately NOT carried over: the old row's is_current would insert
      // a SECOND is_current=true row for this job_id while the old row is
      // still current, tripping quotes_one_current_per_job (migration 061)
      // the instant this insert runs. New quotes always start not-current —
      // set_current_quote below is what correctly flips ownership over.
      is_current: _oldIsCurrent,
      // Also deliberately NOT carried over (quote lifecycle integrity fix):
      // a copied qa_report would be a stale snapshot from the OLD quote,
      // and — critically — a non-null value here suppresses the quote GET
      // route's existing lazy-refresh-on-GET fallback (it only runs
      // runQualityAssurance when qa_report is null). Left null here so that
      // fallback stays live as a safety net even if the explicit
      // runQualityAssurance call below (best-effort, never throws) fails.
      qa_report: _oldQaReport,
      ...quoteFields
    } = existingQuote as Record<string, unknown>

    const { data: newQuote, error: insertQuoteErr } = await supabase
      .from('quotes')
      .insert({ ...quoteFields, version: newVersion, status: 'draft', sent_at: null, approved_at: null })
      .select('id, version, job_id')
      .single()

    if (insertQuoteErr || !newQuote) {
      console.error('[quotes/revise] quote insert failed:', insertQuoteErr?.message)
      return NextResponse.json({ error: 'Failed to create revised quote' }, { status: 500 })
    }

    // A revised quote is the new current one for this job — the partial
    // unique index (migration 061) is the actual guarantee against two
    // quotes ever both being current; this RPC is the normal, correctness-
    // preserving path to it. Best-effort: a failure here leaves the OLD
    // quote current (stale, but never ambiguous), matching this codebase's
    // established posture for derived-state writes (e.g. recomputeQuoteTotals
    // just below) — it must never block the revision itself from succeeding.
    const { error: currentErr } = await supabase.rpc('set_current_quote', {
      p_job_id: newQuote.job_id, p_quote_id: newQuote.id,
    })
    if (currentErr) console.error('[quotes/revise] set_current_quote failed:', currentErr.message)

    if ((existingItems ?? []).length > 0) {
      const newLineItems = (existingItems ?? []).map((item: Record<string, unknown>) => {
        const { id: _itemId, quote_id: _itemQuoteId, created_at: _itemCreatedAt, ...itemFields } = item
        return { ...itemFields, quote_id: newQuote.id }
      })

      const { error: insertItemsErr } = await supabase.from('quote_line_items').insert(newLineItems)
      if (insertItemsErr) {
        console.error('[quotes/revise] line item copy failed:', insertItemsErr.message)
        return NextResponse.json({ error: 'Failed to copy quote line items' }, { status: 500 })
      }
    }

    // Quote lifecycle integrity fix (see the fetch above): carry forward
    // every unresolved conservative assumption so the send gate
    // (getSendBlockingReasons) sees the same unresolved risk on the revised
    // quote that it saw on the original — a revision must never be a way to
    // silently shed a "blocking" clarifying question WorkA never actually
    // got an answer to. New ids (never reuse the old row's id — it's a
    // separate row on a separate quote), line_item_id/gate stay null by
    // construction (that's what the fetch filtered on), resolution stays
    // unresolved (that's the whole point of only copying these rows).
    if ((unresolvedConservativeAssumptions ?? []).length > 0) {
      const newAssumptions = (unresolvedConservativeAssumptions ?? []).map((a: Record<string, unknown>) => {
        const { id: _assumptionId, quote_id: _assumptionQuoteId, created_at: _assumptionCreatedAt, ...assumptionFields } = a
        return { ...assumptionFields, quote_id: newQuote.id }
      })

      const { error: insertAssumptionsErr } = await supabase.from('assumptions').insert(newAssumptions)
      if (insertAssumptionsErr) {
        console.error('[quotes/revise] conservative assumption copy failed:', insertAssumptionsErr.message)
        return NextResponse.json({ error: 'Failed to copy quote assumptions' }, { status: 500 })
      }
    }

    await recomputeQuoteTotals(supabase, newQuote.id)

    // Recalculated, not copied (qa_report was stripped from the insert
    // above) — the new quote gets its own accurate QA state, including a
    // fresh missing-trade check against its own (copied) line items, rather
    // than trusting a snapshot computed for a different quote row.
    // Background, not awaited: QA is a review-time signal (Background tier
    // — see CLAUDE.md's execution-tier documentation), never a send-time
    // gate — send/confirm-send derive missingTrades/unresolved-assumptions
    // fresh from scope_items/quote_line_items/assumptions directly, not
    // from qa_report, so a request racing ahead of this write can never see
    // a falsely-clear send gate. Response payload never included qa_report
    // either, so nothing observable changes for the caller.
    runInBackground('revise_quality_assurance', async () => {
      const { runQualityAssurance } = await import('@/lib/estimating/qa')
      await runQualityAssurance(supabase, newQuote.id, newQuote.job_id)
    })

    console.log(JSON.stringify({
      event: 'quote_revise', quote_id: quoteId, new_quote_id: newQuote.id,
      item_count: (existingItems ?? []).length,
      copied_assumption_count: (unresolvedConservativeAssumptions ?? []).length,
      duration_ms: Date.now() - startedAt,
    }))

    const response: ReviseResponse = { new_quote_id: newQuote.id, version: newQuote.version }
    return NextResponse.json(response, { status: 201 })
  } catch (err) {
    console.error('[quotes/revise] error:', err)
    return NextResponse.json({ error: 'Failed to create revised quote' }, { status: 500 })
  }
}
