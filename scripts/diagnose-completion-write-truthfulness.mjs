#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only, platform-wide
// production check for the smooth-responder final-completion-write
// persistence-truthfulness fix (Round 3 reliability audit finding).
//
// Looks for the exact inconsistency the fix closes: files.intake_status
// derives to 'extracted' (from document_processing_batches.quote_id, a
// SEPARATE write — migration 052) while files.quote_id itself is still
// null, meaning the primary completion write (files.update() setting
// quote_id/intake_stage/pct) silently failed. This is the state that made
// a fully correct, fully priced quote invisible to the builder via the SSE
// completion path (intake_status === 'extracted' && quote_id).
//
// Two shapes checked:
//   1. Queue-model files (processing_batch_id set): intake_status='extracted'
//      AND quote_id IS NULL AND the batch's own quote_id IS NOT NULL —
//      confirms the batch-level write succeeded but the file-level one did
//      not, isolating the exact defect this fix targets.
//   2. Any other file (legacy/no-batch path, or a batch row that's itself
//      missing quote_id for some other reason): intake_status='extracted'
//      AND quote_id IS NULL, reported separately since the batch-level
//      corroboration isn't available to confirm the same root cause.
//
// Read-only. Modifies nothing. Reports counts and IDs only — does not
// repair any row found.
//
// Usage: node scripts/diagnose-completion-write-truthfulness.mjs
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

  const { data: mismatched, error: mismatchErr } = await supabase
    .from('files')
    .select('id, job_id, filename, intake_status, quote_id, processing_batch_id, updated_at')
    .eq('intake_status', 'extracted')
    .is('quote_id', null)

  if (mismatchErr) {
    console.error(JSON.stringify({ event: 'files_query_failed', error: mismatchErr.message }))
    process.exit(1)
  }

  const rows = mismatched ?? []
  console.log(JSON.stringify({ event: 'candidate_mismatch_count', count: rows.length }))

  if (rows.length === 0) {
    console.log(JSON.stringify({ event: 'run_complete', mismatches_found: 0 }))
    return
  }

  const batchIds = Array.from(new Set(rows.map((r) => r.processing_batch_id).filter(Boolean)))
  let batchesById = {}
  if (batchIds.length > 0) {
    const { data: batches, error: batchesErr } = await supabase
      .from('document_processing_batches')
      .select('id, quote_id, status')
      .in('id', batchIds)
    if (batchesErr) {
      console.error(JSON.stringify({ event: 'batches_query_failed', error: batchesErr.message }))
      process.exit(1)
    }
    batchesById = Object.fromEntries((batches ?? []).map((b) => [b.id, b]))
  }

  const confirmedQueueModelMismatches = []
  const otherMismatches = []

  for (const row of rows) {
    const batch = row.processing_batch_id ? batchesById[row.processing_batch_id] : null
    if (batch && batch.quote_id) {
      confirmedQueueModelMismatches.push({
        file_id: row.id, job_id: row.job_id, filename: row.filename,
        processing_batch_id: row.processing_batch_id, batch_quote_id: batch.quote_id,
        updated_at: row.updated_at,
      })
    } else {
      otherMismatches.push({
        file_id: row.id, job_id: row.job_id, filename: row.filename,
        processing_batch_id: row.processing_batch_id, batch_quote_id: batch?.quote_id ?? null,
        updated_at: row.updated_at,
      })
    }
  }

  console.log(JSON.stringify({
    event: 'confirmed_queue_model_mismatches',
    description: 'intake_status=extracted, files.quote_id NULL, but document_processing_batches.quote_id IS SET — the exact defect this fix targets',
    count: confirmedQueueModelMismatches.length,
    rows: confirmedQueueModelMismatches,
  }))

  console.log(JSON.stringify({
    event: 'other_mismatches',
    description: 'intake_status=extracted, files.quote_id NULL, but no corroborating batch.quote_id (legacy path or batch itself missing quote_id) — same symptom, root cause not confirmed by this query alone',
    count: otherMismatches.length,
    rows: otherMismatches,
  }))

  console.log(JSON.stringify({ event: 'run_complete', mismatches_found: rows.length }))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
