#!/usr/bin/env node
// ============================================================
// WorkA — one-time: permanently delete a builder's jobs and all
// Supabase data attached to them (real DELETE, not archive).
// ============================================================
// User-requested, explicitly confirmed hard delete for one specific real
// builder account. This is deliberately NOT the app's normal DELETE
// /api/jobs/[jobId] route, which archives (jobs.status = 'archived') to
// preserve the WorkA Proof audit trail — see that route's own header
// comment. This script exists for the one-off case where the builder
// explicitly wants the data gone, not hidden.
//
// Most job-scoped tables cascade from jobs(id) ON DELETE CASCADE (quotes,
// quote_line_items, variations, job_tasks, job_workers, project_facts,
// scope_items, clarifying_questions, estimate_runs, document_processing_*,
// job_milestones, invoice_schedule, job_intake_locks, etc — see
// supabase/migrations for the full list). Two tables reference jobs(id)
// with NO cascade action (communication_history, files) — deleted
// explicitly here first so the final `DELETE FROM jobs` doesn't hit a
// foreign-key violation. Storage objects for those files are removed from
// the 'plans' bucket first, best-effort, since deleting the DB row alone
// would leave the underlying binary orphaned in Storage.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types scripts/dev-delete-builder-data.mjs --email=<email>
// ============================================================

import { createClient } from '@supabase/supabase-js'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=')
    return [k, rest.join('=')]
  })
)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}
if (!args.email) {
  console.error('Required: --email=<builder email>')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  const { data: builder, error: builderErr } = await supabase
    .from('builders')
    .select('id, email, name')
    .eq('email', args.email)
    .single()
  if (builderErr || !builder) throw new Error(`Builder not found for ${args.email}: ${builderErr?.message ?? 'no row'}`)
  log('builder_found', builder)

  const { data: jobs, error: jobsErr } = await supabase
    .from('jobs')
    .select('id, address, status')
    .eq('builder_id', builder.id)
  if (jobsErr) throw new Error(`Failed to list jobs: ${jobsErr.message}`)
  if (!jobs || jobs.length === 0) {
    log('no_jobs_found', { builder_id: builder.id })
    return
  }
  const jobIds = jobs.map((j) => j.id)
  log('jobs_found', { count: jobs.length, jobs })

  // ── Storage cleanup (best-effort) ────────────────────────────────────
  const { data: fileRows, error: fileErr } = await supabase
    .from('files')
    .select('id, storage_path')
    .in('job_id', jobIds)
  if (fileErr) throw new Error(`Failed to list files: ${fileErr.message}`)

  if (fileRows && fileRows.length > 0) {
    const paths = fileRows.map((f) => f.storage_path).filter(Boolean)
    if (paths.length > 0) {
      const { error: storageErr } = await supabase.storage.from('plans').remove(paths)
      if (storageErr) log('storage_cleanup_failed', { error: storageErr.message, count: paths.length })
      else log('storage_cleanup_done', { count: paths.length })
    }
  }

  // ── Tables referencing jobs(id) with no cascade ──────────────────────
  const { error: commErr } = await supabase.from('communication_history').delete().in('job_id', jobIds)
  if (commErr) throw new Error(`Failed to delete communication_history: ${commErr.message}`)
  log('communication_history_deleted', { job_count: jobIds.length })

  const { error: filesDelErr } = await supabase.from('files').delete().in('job_id', jobIds)
  if (filesDelErr) throw new Error(`Failed to delete files: ${filesDelErr.message}`)
  log('files_deleted', { count: fileRows?.length ?? 0 })

  // ── Jobs themselves — cascades to every remaining job-scoped table ───
  const { error: jobsDelErr } = await supabase.from('jobs').delete().eq('builder_id', builder.id)
  if (jobsDelErr) throw new Error(`Failed to delete jobs: ${jobsDelErr.message}`)
  log('jobs_deleted', { builder_id: builder.id, count: jobIds.length })

  console.log(JSON.stringify({ event: 'delete_complete', builder_id: builder.id, email: builder.email, jobs_deleted: jobIds.length }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'delete_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
