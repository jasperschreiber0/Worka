import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { DEMO_QUOTE } from '@/lib/quote-demo'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { recomputeQuoteTotals } from '@/lib/pricing'

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

    await recomputeQuoteTotals(supabase, newQuote.id)

    const response: ReviseResponse = { new_quote_id: newQuote.id, version: newQuote.version }
    return NextResponse.json(response, { status: 201 })
  } catch (err) {
    console.error('[quotes/revise] error:', err)
    return NextResponse.json({ error: 'Failed to create revised quote' }, { status: 500 })
  }
}
