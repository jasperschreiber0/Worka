#!/usr/bin/env node
// ============================================================
// Production E2E for reliability audit finding #1 (project_facts insert
// in POST /api/intake/[fileId]/clarify). Not wired into a milestone —
// a one-shot verification script for this specific fix.
//
// Uses a synthetic, disposable job + directly-inserted clarifying_questions
// row (builder_id 00000000-0000-0000-0000-0000000000f2, reserved, distinct
// from every other E2E script's id) rather than driving a real document
// upload through Stage 1-5 to force a real blocking gap -- forcing a real
// gap deterministically would require a specifically crafted incomplete
// document set and real Anthropic spend, disproportionate to verifying a
// route whose fix is entirely local to its own persistence/gating logic
// and does not touch Stage 4/5 gap detection at all. This DOES exercise
// the real, deployed POST /api/intake/[fileId]/clarify route via a real
// HTTP call, and independently re-queries the DB afterward -- it does not
// trust the API response alone.
//
// Verifies:
//   1. clarifying_questions.answer is set correctly
//   2. exactly one matching project_facts builder_answer row exists
//   3. resubmitting the identical answer does not create a duplicate fact
//   4. no unrelated financial/estimate records exist for this synthetic job
//      (trivially true here -- no quote/costs/variations are ever created
//      for it -- confirmed, not assumed)
//
// Does NOT and cannot verify, from this script alone, that Stage 3
// genuinely "resumes" using the persisted fact in a live multi-stage run --
// that would require a real paused engine run. That half of requirement 3
// is covered by code review + unit tests (shouldResumeAfterClarify gates
// the resume-trigger call itself) rather than a live observation here;
// disclosed explicitly in the final report, not overclaimed.
//
// Cleans up its own synthetic rows in a finally block.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = process.env.APP_URL

const BUILDER_ID = '00000000-0000-0000-0000-0000000000f2' // reserved, distinct from every other E2E script's id

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must be set' }))
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

let jobId = null
let questionId = null
let fileId = null

async function cleanup() {
  try {
    if (jobId) {
      await supabase.from('project_facts').delete().eq('job_id', jobId)
      await supabase.from('clarifying_questions').delete().eq('job_id', jobId)
      await supabase.from('job_intake_locks').delete().eq('job_id', jobId)
      await supabase.from('jobs').delete().eq('id', jobId)
    }
    log('cleanup_done', { job_id: jobId })
  } catch (err) {
    log('cleanup_failed', { job_id: jobId, error: err instanceof Error ? err.message : String(err) })
  }
}

async function main() {
  let passed = true
  const failures = []

  // ── Setup: synthetic job + one blocking clarifying question ──────────
  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'clarify-e2e@getworka.com', name: 'Clarify Persistence E2E' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  const { data: job, error: jobErr } = await supabase
    .from('jobs')
    .insert({ builder_id: BUILDER_ID, address: `${randomUUID()} Test St, Clarify E2E`, status: 'quoting' })
    .select('id')
    .single()
  if (jobErr || !job) {
    log('setup_failed', { stage: 'create_job', error: jobErr?.message })
    process.exit(1)
  }
  jobId = job.id
  fileId = randomUUID() // no real files row needed -- the route falls back to this if no file is 'needs_info'
  log('job_created', { job_id: jobId })

  const questionText = `E2E test question ${randomUUID()} — what is the slab thickness?`
  const { data: question, error: qErr } = await supabase
    .from('clarifying_questions')
    .insert({ job_id: jobId, question: questionText, reason: 'E2E test', blocking: true, status: 'open' })
    .select('id')
    .single()
  if (qErr || !question) {
    log('setup_failed', { stage: 'create_clarifying_question', error: qErr?.message })
    await cleanup()
    process.exit(1)
  }
  questionId = question.id
  log('clarifying_question_created', { question_id: questionId, question: questionText })

  const answerValue = '150mm'
  const authHeaders = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'x-worka-builder-id': BUILDER_ID,
  }

  // ── Call 1: real submission ───────────────────────────────────────────
  const res1 = await fetch(`${APP_URL.replace(/\/$/, '')}/api/intake/${fileId}/clarify`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ job_id: jobId, answers: [{ question_id: questionId, answer: answerValue }] }),
  })
  const body1 = await res1.json().catch(() => ({}))
  log('clarify_call_1', { http_status: res1.status, body: body1 })

  // Independent DB verification -- not trusting the API response alone.
  const { data: cqRow1 } = await supabase
    .from('clarifying_questions')
    .select('status, answer')
    .eq('id', questionId)
    .single()
  log('clarifying_questions_state_after_call_1', cqRow1 ?? {})
  if (cqRow1?.answer !== answerValue) {
    passed = false
    failures.push('clarifying_questions.answer does not match the submitted answer after call 1')
  }

  const { data: facts1 } = await supabase
    .from('project_facts')
    .select('id, category, key, value, confidence, superseded')
    .eq('job_id', jobId)
    .eq('category', 'builder_answer')
  log('project_facts_state_after_call_1', { count: facts1?.length ?? 0, rows: facts1 })
  if ((facts1?.length ?? 0) !== 1) {
    passed = false
    failures.push(`expected exactly 1 builder_answer project_facts row after call 1, found ${facts1?.length ?? 0}`)
  } else if (facts1[0].key !== questionText || facts1[0].value !== answerValue || facts1[0].confidence != 100) {
    passed = false
    failures.push('the single project_facts row does not match the submitted question/answer/confidence')
  }

  // ── Call 2: identical resubmission -- must not duplicate the fact ────
  const res2 = await fetch(`${APP_URL.replace(/\/$/, '')}/api/intake/${fileId}/clarify`, {
    method: 'POST',
    headers: authHeaders,
    body: JSON.stringify({ job_id: jobId, answers: [{ question_id: questionId, answer: answerValue }] }),
  })
  const body2 = await res2.json().catch(() => ({}))
  log('clarify_call_2_resubmission', { http_status: res2.status, body: body2 })

  const { data: facts2 } = await supabase
    .from('project_facts')
    .select('id, category, key, value')
    .eq('job_id', jobId)
    .eq('category', 'builder_answer')
  log('project_facts_state_after_call_2', { count: facts2?.length ?? 0, rows: facts2 })
  if ((facts2?.length ?? 0) !== 1) {
    passed = false
    failures.push(`expected exactly 1 builder_answer project_facts row after resubmission (no duplicate), found ${facts2?.length ?? 0}`)
  }

  // ── No unrelated financial/estimate records exist for this job ───────
  const { count: quoteCount } = await supabase.from('quotes').select('id', { count: 'exact', head: true }).eq('job_id', jobId)
  const { count: costCount } = await supabase.from('job_cost_entries').select('id', { count: 'exact', head: true }).eq('job_id', jobId)
  const { count: variationCount } = await supabase.from('variations').select('id', { count: 'exact', head: true }).eq('job_id', jobId)
  log('unrelated_records_check', { quotes: quoteCount ?? 0, job_cost_entries: costCount ?? 0, variations: variationCount ?? 0 })
  if ((quoteCount ?? 0) !== 0 || (costCount ?? 0) !== 0 || (variationCount ?? 0) !== 0) {
    passed = false
    failures.push('unexpected financial/estimate records exist for this synthetic job')
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
