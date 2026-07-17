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
      // Risk acceptance applies to the exact quote version it was given for —
      // a revised quote is a different set of line items and must start with
      // no acknowledgement, never inherit the prior version's. This was
      // missing when migration 038 added these columns, so a revised quote
      // silently carried the old version's acknowledgement forward. See the
      // Phase 1.2 production trust audit.
      risk_acknowledged_at: _oldRiskAcknowledgedAt, risk_acknowledgement_snapshot: _oldRiskSnapshot,
      ...quoteFields
    } = existingQuote as Record<string, unknown>

    const { data: newQuote, error: insertQuoteErr } = await supabase
      .from('quotes')
      .insert({ ...quoteFields, version: newVersion, status: 'draft', sent_at: null, approved_at: null })
      .select('id, version')
      .single()

    if (insertQuoteErr || !newQuote) {
      console.error('[quotes/revise] quote insert failed:', insertQuoteErr?.message)
      return NextResponse.json({ error: 'Failed to create revised quote' }, { status: 500 })
    }

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
