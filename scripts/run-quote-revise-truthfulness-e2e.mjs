#!/usr/bin/env node
// ============================================================
// Production E2E for the quote-revise persistence-truthfulness fix
// (Round 8 reliability audit finding). Not part of any milestone.
//
// Drives the real, deployed POST /api/quotes/[quoteId]/revise route:
//   1. A 'draft' quote can still be revised normally (happy path unaffected).
//   2. A 'sent' quote is rejected with 409 -- independently verified that
//      NO new quote row was created and is_current did not move.
//   3. An 'approved' quote is rejected with 409 -- same independent checks.
//
// Cleans up all synthetic rows in a finally block.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL

const BUILDER_ID = '00000000-0000-0000-0000-0000000001f0' // every single-byte 00...00f0-ff suffix is already reserved by another E2E script in this session's ledger; this uses the next free id outside that range

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must be set' }))
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

const authHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
  'x-worka-builder-id': BUILDER_ID,
}

const allJobIds = []
const allQuoteIds = []

async function makeJobWithQuote(status, suffix) {
  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ builder_id: BUILDER_ID, address: `${randomUUID()} Test St, Revise Truthfulness E2E ${suffix}`, status: 'active' })
    .select('id')
    .single()
  if (jobErr || !job) throw new Error(`create_job failed: ${jobErr?.message}`)
  allJobIds.push(job.id)

  const { data: quote, error: quoteErr } = await supabase
    .from('quotes')
    .insert({ job_id: job.id, builder_id: BUILDER_ID, status, total_cost: 10000, margin_pct: 0.2, confidence_score: 100, version: 1, is_current: true })
    .select('id')
    .single()
  if (quoteErr || !quote) throw new Error(`create_quote failed: ${quoteErr?.message}`)
  allQuoteIds.push(quote.id)

  return { jobId: job.id, quoteId: quote.id }
}

async function cleanup() {
  try {
    if (allQuoteIds.length > 0) {
      await supabase.from('quote_line_items').delete().in('quote_id', allQuoteIds)
    }
    if (allJobIds.length > 0) {
      await supabase.from('quotes').delete().in('job_id', allJobIds)
      await supabase.from('jobs').delete().in('id', allJobIds)
    }
    log('cleanup_done', { job_ids: allJobIds })
  } catch (err) {
    log('cleanup_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

async function main() {
  let passed = true
  const failures = []

  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'quote-revise-truthfulness-e2e@getworka.com', name: 'Quote Revise Truthfulness E2E' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  // ── 1. Draft quote can still be revised (happy path unaffected) ────────
  const draftJob = await makeJobWithQuote('draft', 'draft')
  log('draft_job_created', draftJob)

  const draftRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/quotes/${draftJob.quoteId}/revise`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ builder_id: BUILDER_ID }),
  })
  const draftBody = await draftRes.json().catch(() => ({}))
  log('draft_revise_call', { http_status: draftRes.status, body: draftBody })

  if (!draftRes.ok || !draftBody.new_quote_id) {
    passed = false
    failures.push(`expected a draft quote to be revisable, got ${draftRes.status}: ${JSON.stringify(draftBody)}`)
  } else {
    allQuoteIds.push(draftBody.new_quote_id)
  }

  const { data: draftCurrent } = await supabase.from('quotes').select('id, status').eq('job_id', draftJob.jobId).eq('is_current', true).single()
  log('draft_is_current_after_revise', draftCurrent ?? {})
  if (draftCurrent?.id !== draftBody.new_quote_id) {
    passed = false
    failures.push(`expected the new revision to become is_current for a draft-quote revise, got ${JSON.stringify(draftCurrent)}`)
  }

  // ── 2. Sent quote rejected ──────────────────────────────────────────────
  const sentJob = await makeJobWithQuote('sent', 'sent')
  log('sent_job_created', sentJob)

  const sentRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/quotes/${sentJob.quoteId}/revise`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ builder_id: BUILDER_ID }),
  })
  const sentBody = await sentRes.json().catch(() => ({}))
  log('sent_revise_call', { http_status: sentRes.status, body: sentBody })

  if (sentRes.status !== 409) {
    passed = false
    failures.push(`expected 409 for a sent quote, got ${sentRes.status}`)
  }

  const { data: sentQuotesAfter } = await supabase.from('quotes').select('id, status, is_current').eq('job_id', sentJob.jobId)
  log('quotes_after_sent_revise_attempt', { rows: sentQuotesAfter })
  if ((sentQuotesAfter?.length ?? 0) !== 1) {
    passed = false
    failures.push(`expected the sent quote to remain the ONLY quote for its job (no new draft created), found ${sentQuotesAfter?.length}`)
  }
  if (sentQuotesAfter?.[0]?.is_current !== true || sentQuotesAfter?.[0]?.status !== 'sent') {
    passed = false
    failures.push(`expected the original sent quote to remain is_current and status='sent', got ${JSON.stringify(sentQuotesAfter?.[0])}`)
  }

  // ── 3. Approved quote rejected ──────────────────────────────────────────
  const approvedJob = await makeJobWithQuote('approved', 'approved')
  log('approved_job_created', approvedJob)

  const approvedRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/quotes/${approvedJob.quoteId}/revise`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ builder_id: BUILDER_ID }),
  })
  const approvedBody = await approvedRes.json().catch(() => ({}))
  log('approved_revise_call', { http_status: approvedRes.status, body: approvedBody })

  if (approvedRes.status !== 409) {
    passed = false
    failures.push(`expected 409 for an approved quote, got ${approvedRes.status}`)
  }

  const { data: approvedQuotesAfter } = await supabase.from('quotes').select('id, status, is_current').eq('job_id', approvedJob.jobId)
  log('quotes_after_approved_revise_attempt', { rows: approvedQuotesAfter })
  if ((approvedQuotesAfter?.length ?? 0) !== 1) {
    passed = false
    failures.push(`expected the approved quote to remain the ONLY quote for its job (no new draft created), found ${approvedQuotesAfter?.length}`)
  }
  if (approvedQuotesAfter?.[0]?.is_current !== true || approvedQuotesAfter?.[0]?.status !== 'approved') {
    passed = false
    failures.push(`expected the original approved quote to remain is_current and status='approved', got ${JSON.stringify(approvedQuotesAfter?.[0])}`)
  }

  log(passed ? 'run_passed' : 'run_FAILED', { passed, failures })
  await cleanup()
  process.exit(passed ? 0 : 1)
}

main().catch(async (err) => {
  log('run_crashed', { error: err instanceof Error ? err.stack : String(err) })
  await cleanup()
  process.exit(1)
})
