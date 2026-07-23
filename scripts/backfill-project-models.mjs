#!/usr/bin/env node
// ============================================================
// WorkA — one-time project_models backfill (estimator rebuild, Phase 1)
// ============================================================
// project_models is a pure, derived projection of project_facts (see
// migration 068's header comment) — this script fills it in for every job
// that already has active facts but no model yet, so Phase 1's cache isn't
// only warm for jobs processed after the write-through wiring shipped.
//
// Imports buildProjectModel directly from pipeline-logic.ts (a relative,
// .ts-suffixed import, not a duplicated copy) so this script and the live
// Deno pipeline can never disagree on how a project_facts row gets bucketed
// — the same cross-runtime-import pattern lib/project-context.test.ts
// already uses, run here via `node --experimental-strip-types`.
//
// Idempotent (project_models.job_id is a primary key, upserted) and
// read-only against everything except project_models itself — safe to
// re-run, safe to interrupt.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types scripts/backfill-project-models.mjs

import { createClient } from '@supabase/supabase-js'
import { buildProjectModel } from '../supabase/functions/smooth-responder/pipeline-logic.ts'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({
    event: 'backfill_config_error',
    message: 'NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must both be set',
  }))
  process.exit(1)
}

const PAGE_SIZE = 500

async function run() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  // Distinct job_ids with at least one active fact — paginated, since a
  // production instance can have thousands of project_facts rows.
  const jobIds = new Set()
  let from = 0
  for (;;) {
    const { data, error } = await supabase
      .from('project_facts')
      .select('job_id')
      .eq('superseded', false)
      .range(from, from + PAGE_SIZE - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    for (const row of data) jobIds.add(row.job_id)
    if (data.length < PAGE_SIZE) break
    from += PAGE_SIZE
  }

  const ids = Array.from(jobIds)
  console.log(JSON.stringify({ event: 'backfill_started', job_count: ids.length }))

  let succeeded = 0
  let failed = 0

  for (const jobId of ids) {
    try {
      const { data: facts, error: factsErr } = await supabase
        .from('project_facts')
        .select('category, key, value, confidence, source_document_id, evidence')
        .eq('job_id', jobId)
        .eq('superseded', false)
      if (factsErr) throw factsErr
      if (!facts || facts.length === 0) continue

      const sections = buildProjectModel(facts)
      const { error: upsertErr } = await supabase.from('project_models').upsert({
        job_id: jobId,
        sections,
        source_fact_count: facts.length,
        derived_at: new Date().toISOString(),
      })
      if (upsertErr) throw upsertErr
      succeeded += 1
    } catch (err) {
      failed += 1
      console.error(JSON.stringify({ event: 'backfill_job_failed', job_id: jobId, error: err instanceof Error ? err.message : String(err) }))
    }
  }

  console.log(JSON.stringify({ event: 'backfill_complete', succeeded, failed, total: ids.length }))
  if (failed > 0) process.exitCode = 1
}

run().catch((err) => {
  console.error(JSON.stringify({ event: 'backfill_fatal_error', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
