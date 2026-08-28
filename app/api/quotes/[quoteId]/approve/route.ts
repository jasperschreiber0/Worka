import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { daysAgo } from '@/lib/job-activity'
import { recordProofEvent } from '@/lib/proof'
import {
  isQuoteApprovableByClient,
  isQuoteViewableByClient,
  buildClientVisibleQuote,
  type QuoteStatus,
  type QuoteLineItemForClient,
} from '@/lib/quote-approval'

// ─── Public, token-scoped client quote review & approval ──────────────────
//
// Deliberately a SEPARATE route from app/api/quotes/[quoteId]/route.ts (the
// existing authenticated, builder-facing quote GET) rather than branching
// inside it — full isolation from that route's existing behaviour, same
// reasoning as keeping this feature out of send/confirm-send/activate
// entirely. Mirrors app/api/variations/[variationId]/route.ts's token
// verification pattern: the share token is the ONLY authorization for
// either method here, never a builder session.
//
// GET: returns only the client-safe view (lib/quote-approval.ts's
// buildClientVisibleQuote) — never total_cost, rate, margin_pct,
// confidence, pricing_source, or assumption_status.
// PATCH: 'approved' — atomic, forward-only, status-filtered update
//        (replay-proof by construction: a second call finds 0 rows).
//        'changes_requested' — records a proof event only; no write to
//        the quotes row, so financial/status state is provably untouched.

interface QuoteRow {
  id: string
  job_id: string
  builder_id: string
  status: QuoteStatus
  sent_at: string | null
  approved_at: string | null
  approved_by: string | null
  share_token_hash: string | null
  share_token_expires_at: string | null
}

function realSb() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !serviceRoleKey) return null
  return createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
}

/**
 * Verifies a client-supplied share token against the stored hash + expiry.
 * Returns the row only when the token is present, matches, and hasn't
 * expired — the sole authorization check for this entire route.
 */
async function loadByShareToken(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: any,
  quoteId: string,
  token: string
): Promise<QuoteRow | null> {
  const { data } = await sb
    .from('quotes')
    .select('id, job_id, builder_id, status, sent_at, approved_at, approved_by, share_token_hash, share_token_expires_at')
    .eq('id', quoteId)
    .single()

  const row = data as QuoteRow | null
  if (!row || !row.share_token_hash) return null

  const tokenHash = createHash('sha256').update(token).digest('hex')
  if (tokenHash !== row.share_token_hash) return null

  if (row.share_token_expires_at && new Date(row.share_token_expires_at).getTime() < Date.now()) {
    return null
  }

  return row
}

// ─── GET /api/quotes/[quoteId]/approve?t=... ───────────────────────────────

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ quoteId: string }> }
): Promise<NextResponse> {
  const { quoteId } = await params
  const token = request.nextUrl.searchParams.get('t')
  if (!token) {
    return NextResponse.json({ error: 'Missing or invalid link' }, { status: 401 })
  }

  const sb = realSb()
  if (!sb) return NextResponse.json({ error: 'Not configured' }, { status: 503 })

  const row = await loadByShareToken(sb, quoteId, token)
  if (!row) return NextResponse.json({ error: 'Quote not found' }, { status: 404 })

  // Never expose draft/pending_review financial data — a share link only
  // ever becomes meaningful once the quote has actually been sent.
  if (!isQuoteViewableByClient(row.status)) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
  }

  const [{ data: job }, { data: lineItems }] = await Promise.all([
    sb.from('jobs').select('address, clients(name)').eq('id', row.job_id).single(),
    sb.from('quote_line_items').select('trade_category_id, description, total, margin_pct, assumption_status').eq('quote_id', quoteId),
  ])

  const jobAddress = (job as { address: string } | null)?.address ?? 'your job'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const clientName = (job as any)?.clients?.name ?? 'there'

  const clientQuote = buildClientVisibleQuote((lineItems ?? []) as QuoteLineItemForClient[])

  return NextResponse.json({
    quote: {
      status: row.status,
      job_address: jobAddress,
      client_name: clientName,
      sent_display: row.sent_at ? daysAgo(row.sent_at) : null,
      approved_at: row.approved_at,
      approved_by: row.approved_by,
      categories: clientQuote.categories,
      total: clientQuote.total,
    },
  })
}

// ─── PATCH /api/quotes/[quoteId]/approve — client accepts or requests changes ──

interface PatchBody {
  decision?: 'approved' | 'changes_requested'
  approved_by?: string
  message?: string
  t?: string
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ quoteId: string }> }
): Promise<NextResponse> {
  const { quoteId } = await params

  let body: PatchBody
  try {
    body = (await request.json()) as PatchBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { decision } = body
  if (decision !== 'approved' && decision !== 'changes_requested') {
    return NextResponse.json({ error: 'Invalid decision' }, { status: 400 })
  }

  const token = body.t ?? request.nextUrl.searchParams.get('t')
  if (!token) {
    return NextResponse.json({ error: 'Missing or invalid link' }, { status: 401 })
  }

  const sb = realSb()
  if (!sb) return NextResponse.json({ error: 'Not configured' }, { status: 503 })

  const row = await loadByShareToken(sb, quoteId, token)
  if (!row) return NextResponse.json({ error: 'Missing or invalid link' }, { status: 401 })

  if (!isQuoteViewableByClient(row.status)) {
    return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
  }

  const approvedBy = (body.approved_by ?? 'Client').slice(0, 200)
  const now = new Date().toISOString()

  if (decision === 'approved') {
    if (!isQuoteApprovableByClient(row.status)) {
      return NextResponse.json({ error: `Quote is already ${row.status} — it cannot be approved again.` }, { status: 422 })
    }

    // Atomic, forward-only, status-filtered update — the actual enforcement
    // (isQuoteApprovableByClient above is the shared eligibility rule this
    // mirrors, not a substitute for it). A concurrent/replayed second PATCH
    // finds 0 rows here and 422s, never a second approval.
    const { data: updatedRows, error } = await sb
      .from('quotes')
      .update({ status: 'approved', approved_at: now, approved_by: approvedBy })
      .eq('id', quoteId)
      .eq('status', 'sent')
      .select('id, status, approved_at, approved_by')

    const updated = (updatedRows as { id: string; status: string; approved_at: string; approved_by: string }[] | null)?.[0]
    if (error || !updated) {
      return NextResponse.json({ error: 'Quote is already approved — it cannot be approved again.' }, { status: 422 })
    }

    // Proof event recorded only after the write above actually committed.
    await recordProofEvent({
      jobId: row.job_id,
      builderId: row.builder_id,
      eventType: 'quote_approved',
      description: `Client approved the quote (approved by ${approvedBy})`,
      metadata: { quote_id: quoteId, approved_by: approvedBy, decided_at: now },
    })

    return NextResponse.json({
      quote: { status: updated.status, approved_at: updated.approved_at, approved_by: updated.approved_by },
    })
  }

  // decision === 'changes_requested' — deliberately NO write to the quotes
  // row at all: status, approved_at, approved_by, and every financial value
  // stay exactly as they were. Only a proof event, carrying the client's
  // optional message, so the builder has what they need to act.
  const message = typeof body.message === 'string' ? body.message.trim().slice(0, 2000) : ''

  await recordProofEvent({
    jobId: row.job_id,
    builderId: row.builder_id,
    eventType: 'quote_changes_requested',
    description: `Client requested changes to the quote${message ? `: "${message}"` : ''} (from ${approvedBy})`,
    metadata: { quote_id: quoteId, requested_by: approvedBy, message: message || null, requested_at: now },
  })

  return NextResponse.json({ quote: { status: row.status } })
}
