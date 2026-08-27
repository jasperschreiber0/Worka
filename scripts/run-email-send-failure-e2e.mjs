#!/usr/bin/env node
// ============================================================
// Production E2E for the email-draft send persistence-truthfulness fix
// (Round 6 reliability audit finding). Not part of any milestone.
//
// Drives the real, deployed POST /api/email-draft/send route twice against
// live Resend:
//   1. A malformed recipient ("not-a-valid-email", no @) — a genuine
//      Resend-API-level rejection, not a fabricated internal failure —
//      and independently verifies via direct DB query that NEITHER a
//      communication_history row NOR a proof_events 'email_sent' row was
//      created, and that the route returned a non-2xx.
//   2. Resend's own sandbox test address (delivered@resend.dev, guaranteed
//      accepted without requiring a verified custom domain) to prove the
//      happy path is unchanged: both rows ARE created and the route
//      returns 200.
//
// Cleans up all synthetic rows in a finally block.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL

const BUILDER_ID = '00000000-0000-0000-0000-0000000000fa' // reserved, previously unused per this session's own ledger

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must be set' }))
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

let jobId = null
const communicationIdsToClean = []

async function cleanup() {
  try {
    if (communicationIdsToClean.length > 0) {
      await supabase.from('communication_history').delete().in('id', communicationIdsToClean)
    }
    if (jobId) {
      await supabase.from('proof_events').delete().eq('job_id', jobId)
      await supabase.from('jobs').delete().eq('id', jobId)
    }
    log('cleanup_done', { job_id: jobId, communication_ids: communicationIdsToClean })
  } catch (err) {
    log('cleanup_failed', { error: err instanceof Error ? err.message : String(err) })
  }
}

async function main() {
  let passed = true
  const failures = []

  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'email-send-failure-e2e@getworka.com', name: 'Email Send Failure E2E' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ builder_id: BUILDER_ID, address: `${randomUUID()} Test St, Email Send Failure E2E`, status: 'active' })
    .select('id')
    .single()
  if (jobErr || !job) {
    log('setup_failed', { stage: 'create_job', error: jobErr?.message })
    process.exit(1)
  }
  jobId = job.id
  log('job_created', { job_id: jobId })

  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'x-worka-builder-id': BUILDER_ID,
  }

  // ── 1. Genuine Resend-rejected send ────────────────────────────────────
  const proofCountBefore = await countProofEvents(jobId)

  const failRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/email-draft/send`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      job_id: jobId,
      to: 'not-a-valid-email',
      subject: 'E2E — should be rejected by Resend',
      body: 'This send should be rejected by the Resend API itself (malformed recipient), not simulated.',
    }),
  })
  const failBody = await failRes.json().catch(() => ({}))
  log('failure_send_call', { http_status: failRes.status, body: failBody })

  if (failRes.ok) {
    passed = false
    failures.push(`expected non-2xx for a Resend-rejected send, got ${failRes.status}`)
  }

  const { data: commAfterFail } = await supabase
    .from('communication_history')
    .select('id')
    .eq('job_id', jobId)
    .eq('to_address', 'not-a-valid-email')
  log('communication_history_after_failed_send', { count: commAfterFail?.length ?? 0 })
  if ((commAfterFail?.length ?? 0) !== 0) {
    passed = false
    failures.push(`expected no communication_history row after a rejected send, found ${commAfterFail?.length}`)
    communicationIdsToClean.push(...commAfterFail.map((r) => r.id))
  }

  const proofCountAfterFail = await countProofEvents(jobId)
  log('proof_events_after_failed_send', { count: proofCountAfterFail })
  if (proofCountAfterFail !== proofCountBefore) {
    passed = false
    failures.push(`expected no new proof_events row after a rejected send, count went from ${proofCountBefore} to ${proofCountAfterFail}`)
  }

  // ── 2. Genuine successful send (Resend sandbox test address) ───────────
  const okRes = await fetch(`${APP_URL.replace(/\/$/, '')}/api/email-draft/send`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({
      job_id: jobId,
      to: 'delivered@resend.dev',
      subject: 'E2E — should be accepted by Resend',
      body: 'This send should be accepted by Resend (sandbox test address).',
    }),
  })
  const okBody = await okRes.json().catch(() => ({}))
  log('success_send_call', { http_status: okRes.status, body: okBody })

  if (!okRes.ok) {
    passed = false
    failures.push(`expected 2xx for a valid Resend sandbox send, got ${okRes.status}`)
  } else if (okBody.communication_id) {
    communicationIdsToClean.push(okBody.communication_id)
  }

  const { data: commAfterOk } = await supabase
    .from('communication_history')
    .select('id')
    .eq('job_id', jobId)
    .eq('to_address', 'delivered@resend.dev')
  log('communication_history_after_successful_send', { count: commAfterOk?.length ?? 0 })
  if ((commAfterOk?.length ?? 0) !== 1) {
    passed = false
    failures.push(`expected exactly 1 communication_history row after a successful send, found ${commAfterOk?.length}`)
  }

  const proofCountAfterOk = await countProofEvents(jobId)
  log('proof_events_after_successful_send', { count: proofCountAfterOk })
  if (proofCountAfterOk !== proofCountAfterFail + 1) {
    passed = false
    failures.push(`expected exactly 1 new proof_events row after a successful send, count went from ${proofCountAfterFail} to ${proofCountAfterOk}`)
  }

  log(passed ? 'run_passed' : 'run_FAILED', { passed, failures })
  await cleanup()
  process.exit(passed ? 0 : 1)
}

async function countProofEvents(jobId) {
  const { data } = await supabase
    .from('proof_events')
    .select('id')
    .eq('job_id', jobId)
    .eq('event_type', 'email_sent')
  return data?.length ?? 0
}

main().catch(async (err) => {
  log('run_crashed', { error: err instanceof Error ? err.stack : String(err) })
  await cleanup()
  process.exit(1)
})
