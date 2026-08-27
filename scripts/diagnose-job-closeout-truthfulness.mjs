#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only, platform-wide
// production check for the job-closeout persistence-truthfulness fix
// (Round 7 reliability audit finding).
//
// Looks for the exact gap this fix closes: a project_memory row whose
// status='completed' (the idempotency guard's old sole signal) but whose
// closeout never actually completed — either its job never reached
// jobs.status='complete', or it has zero cost_reconciliation rows behind it.
// Either shape means a builder was told "This job was already closed out"
// while the state was never actually finalized.
//
// Read-only. Modifies nothing.
//
// Usage: node scripts/diagnose-job-closeout-truthfulness.mjs
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY must be set' }))
  process.exit(1)
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: completedMemory, error: memErr } = await supabase
    .from('project_memory')
    .select('id, job_id, builder_id, status, completed_at')
    .eq('status', 'completed')
    .not('job_id', 'is', null)

  if (memErr) {
    console.error(JSON.stringify({ event: 'project_memory_query_failed', error: memErr.message }))
    process.exit(1)
  }

  const rows = completedMemory ?? []
  console.log(JSON.stringify({ event: 'completed_project_memory_count', count: rows.length }))

  if (rows.length === 0) {
    console.log(JSON.stringify({ event: 'run_complete', poisoned_count: 0 }))
    return
  }

  const jobIds = rows.map((r) => r.job_id)
  const jobStatusById = new Map()
  const CHUNK = 200
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const chunk = jobIds.slice(i, i + CHUNK)
    const { data: jobs, error: jobErr } = await supabase
      .from('jobs')
      .select('id, status')
      .in('id', chunk)
    if (jobErr) {
      console.error(JSON.stringify({ event: 'jobs_query_failed', error: jobErr.message }))
      process.exit(1)
    }
    for (const j of jobs ?? []) jobStatusById.set(j.id, j.status)
  }

  const memoryIds = rows.map((r) => r.id)
  const reconciledMemoryIds = new Set()
  for (let i = 0; i < memoryIds.length; i += CHUNK) {
    const chunk = memoryIds.slice(i, i + CHUNK)
    const { data: recon, error: reconErr } = await supabase
      .from('cost_reconciliation')
      .select('project_memory_id')
      .in('project_memory_id', chunk)
    if (reconErr) {
      console.error(JSON.stringify({ event: 'cost_reconciliation_query_failed', error: reconErr.message }))
      process.exit(1)
    }
    for (const r of recon ?? []) reconciledMemoryIds.add(r.project_memory_id)
  }

  const poisoned = rows.filter((r) => {
    const jobStatus = jobStatusById.get(r.job_id)
    return jobStatus !== 'complete' || !reconciledMemoryIds.has(r.id)
  })

  console.log(JSON.stringify({
    event: 'poisoned_closeouts',
    description: "project_memory.status='completed' with either the job not at jobs.status='complete' or zero cost_reconciliation rows -- the job-closeout persistence-truthfulness gap this fix closes",
    count: poisoned.length,
    rows: poisoned.slice(0, 50).map((r) => ({
      project_memory_id: r.id,
      job_id: r.job_id,
      builder_id: r.builder_id,
      job_status: jobStatusById.get(r.job_id) ?? null,
      has_cost_reconciliation: reconciledMemoryIds.has(r.id),
    })),
    truncated: poisoned.length > 50,
  }))

  console.log(JSON.stringify({ event: 'run_complete', poisoned_count: poisoned.length }))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
