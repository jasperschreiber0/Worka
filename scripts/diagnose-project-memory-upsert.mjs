#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of Job Closeout v1 — read/write against a
// disposable synthetic row to get the RAW Postgres error from the exact
// upsert POST /api/estimation/reconcile performs against project_memory
// (onConflict: 'job_id'), to confirm or rule out a hypothesis: the only
// unique index on project_memory.job_id (migration 011,
// project_memory_job_id_idx) is PARTIAL ("where job_id is not null"), and
// Postgres cannot infer a partial index as an ON CONFLICT arbiter from a
// plain `ON CONFLICT (job_id)` clause with no matching WHERE — which would
// make the upsert fail every time, silently, since the reconcile route
// never checks the upsert's `error`.
// Deletes its own row in a `finally` block regardless of outcome.
// ============================================================

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY must be set' }))
  process.exit(1)
}

const BUILDER_ID = '00000000-0000-0000-0000-0000000000f6'

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  const jobId = crypto.randomUUID()

  await supabase.from('builders').upsert({ id: BUILDER_ID, email: 'closeout-e2e-check@getworka.com', name: 'Closeout E2E Check' }, { onConflict: 'id', ignoreDuplicates: true })
  const { error: jobErr } = await supabase.from('jobs').insert({
    id: jobId, builder_id: BUILDER_ID,
    address: `DIAGNOSTIC ONLY — project_memory upsert probe (${new Date().toISOString()}), safe to delete`,
    status: 'active', job_type: 'health_check',
  })
  if (jobErr) {
    console.log(JSON.stringify({ event: 'job_insert_failed', error: jobErr }))
    process.exit(1)
  }

  try {
    // Exact same call shape as app/api/estimation/reconcile/route.ts.
    const { data, error } = await supabase
      .from('project_memory')
      .upsert({
        job_id: jobId,
        builder_id: BUILDER_ID,
        quote_id: null,
        status: 'completed',
        final_cost: 1000,
        final_margin_pct: 10,
        completed_at: new Date().toISOString(),
      }, { onConflict: 'job_id' })
      .select()
      .single()

    console.log(JSON.stringify({ event: 'upsert_result', data, error }, null, 2))
  } finally {
    await supabase.from('project_memory').delete().eq('job_id', jobId)
    await supabase.from('jobs').delete().eq('id', jobId)
    console.log(JSON.stringify({ event: 'cleanup_complete' }))
  }
}

main()
