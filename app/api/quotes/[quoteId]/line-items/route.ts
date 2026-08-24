import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { runInBackground } from '@/lib/run-background'
import { isValidTradeCategoryId } from '@/lib/trade-taxonomy'

// ─── POST /api/quotes/[quoteId]/line-items ────────────────────────────────────
//
// Manual line-item creation — the missing piece that let a quote only ever be
// populated by the AI estimation pipeline. Deliberately narrow: Trade,
// Description, Quantity, Unit, Rate — the same five fields the builder types
// on paper today. Total is calculated server-side (quantity × rate), reusing
// the existing recomputeQuoteTotals (lib/pricing.ts) for the quote-level
// aggregate rather than duplicating that arithmetic here.
//
// A manually-created row is otherwise an ordinary quote_line_items row —
// same table, same columns, same rate hierarchy, same PATCH/exclude/pricing
// path an AI-extracted line already uses. pricing_source: 'manual' and
// predicted_by: 'human' (both pre-existing columns — migrations 069/071)
// record provenance only; nothing about how this row is read, priced, or
// sent differs from an AI-generated one.

interface CreateBody {
  trade_category_id?: number
  description?: string
  quantity?: number
  unit?: string
  rate?: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function POST(
  req: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  let body: CreateBody
  try {
    body = await req.json() as CreateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const description = typeof body.description === 'string' ? body.description.trim() : ''
  const unit = typeof body.unit === 'string' ? body.unit.trim() : ''
  const tradeCategoryId = body.trade_category_id
  const { quantity, rate } = body

  if (!description) {
    return NextResponse.json({ error: 'Description is required' }, { status: 400 })
  }
  if (typeof tradeCategoryId !== 'number' || !isValidTradeCategoryId(tradeCategoryId)) {
    return NextResponse.json({ error: 'A valid trade is required' }, { status: 400 })
  }
  if (!unit) {
    return NextResponse.json({ error: 'Unit is required' }, { status: 400 })
  }
  if (typeof quantity !== 'number' || !Number.isFinite(quantity) || quantity <= 0) {
    return NextResponse.json({ error: 'Quantity must be a positive number' }, { status: 400 })
  }
  if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
    return NextResponse.json({ error: 'Rate must be a positive number' }, { status: 400 })
  }

  const { quoteId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Owner + status guard — identical to the PATCH route just below this
    // one in the tree; a quote that's been sent is the audit record of what
    // the client saw and must stay immutable here too.
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
        { error: `Quote is ${quoteRow.status} — items can no longer be added` },
        { status: 422 }
      )
    }

    const { data: newItem, error: insertErr } = await supabase
      .from('quote_line_items')
      .insert({
        quote_id: quoteId,
        trade_category_id: tradeCategoryId,
        description,
        quantity,
        unit,
        rate,
        total: round2(quantity * rate),
        // A builder-entered line is a direct answer, not an inference —
        // same convention the PATCH route uses when a builder prices an
        // unpriced AI line.
        confidence: 100,
        is_assumption: false,
        assumption_status: null,
        pricing_source: 'manual',
        pricing_basis: null,
        predicted_by: 'human',
      })
      .select('id')
      .single()

    if (insertErr) {
      // quote_line_items_unique_per_quote (migration 030): (quote_id,
      // trade_category_id, description) must be unique — surface this as a
      // builder-actionable message instead of a raw constraint error.
      if ((insertErr as { code?: string }).code === '23505') {
        return NextResponse.json(
          { error: 'An item with this description already exists for this trade — use a different description or edit the existing item.' },
          { status: 409 }
        )
      }
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }

    const { recomputeQuoteTotals } = await import('@/lib/pricing')
    await recomputeQuoteTotals(supabase, quoteId)
    runInBackground('line_item_create_quality_assurance', async () => {
      const { runQualityAssurance } = await import('@/lib/estimating/qa')
      await runQualityAssurance(supabase, quoteId, quoteRow.job_id)
    })

    return NextResponse.json({ created: true, item_id: newItem!.id })
  } catch (err) {
    console.error('[line-items:post] error:', err)
    return NextResponse.json({ error: 'Failed to add item — please try again.' }, { status: 500 })
  }
}
