#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only production check
// for the Stage 1/2 document-classification persistence truthfulness fix
// (finding #2 of the reliability audit): for a given job_id, verifies that
// every project_documents row shows extraction_status='complete' with at
// least one corresponding project_facts row (the "no false success" half
// of the invariant), AND that no document has more than one set of
// duplicate facts (same source_document_id + category + key + value
// appearing more than once — the "no duplicate persistence on retry"
// half).
//
// Usage: JOB_ID=<uuid> node scripts/diagnose-document-classification-persistence.mjs
// Read-only. Deletes nothing.
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const JOB_ID = process.env.JOB_ID

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !JOB_ID) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JOB_ID must be set' }))
  process.exit(1)
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: docs, error: docsErr } = await supabase
    .from('project_documents')
    .select('id, file_id, extraction_status, document_type, drawing_title')
    .eq('job_id', JOB_ID)
  if (docsErr) {
    console.error(JSON.stringify({ event: 'project_documents_read_failed', error: docsErr.message }))
    process.exit(1)
  }

  const { data: files, error: filesErr } = await supabase
    .from('files')
    .select('id, filename, intake_status, ai_failure_classification, ai_failure_count, failed_sibling_filenames')
    .eq('job_id', JOB_ID)
  if (filesErr) {
    console.error(JSON.stringify({ event: 'files_read_failed', error: filesErr.message }))
    process.exit(1)
  }

  console.log(JSON.stringify({
    event: 'files_state',
    files: (files ?? []).map((f) => ({
      id: f.id, filename: f.filename, intake_status: f.intake_status,
      ai_failure_classification: f.ai_failure_classification, ai_failure_count: f.ai_failure_count,
    })),
  }))

  console.log(JSON.stringify({
    event: 'project_documents_state',
    documents: (docs ?? []).map((d) => ({ id: d.id, file_id: d.file_id, extraction_status: d.extraction_status, document_type: d.document_type })),
  }))

  // Check 1: no false success -- every project_documents row claiming
  // 'complete' must have at least one project_facts row referencing it.
  const completeDocIds = (docs ?? []).filter((d) => d.extraction_status === 'complete').map((d) => d.id)
  let orphanedCompleteDocIds = []
  if (completeDocIds.length > 0) {
    const { data: factCounts, error: factCountsErr } = await supabase
      .from('project_facts')
      .select('source_document_id')
      .in('source_document_id', completeDocIds)
    if (factCountsErr) {
      console.error(JSON.stringify({ event: 'project_facts_read_failed', error: factCountsErr.message }))
      process.exit(1)
    }
    const docIdsWithFacts = new Set((factCounts ?? []).map((f) => f.source_document_id))
    orphanedCompleteDocIds = completeDocIds.filter((id) => !docIdsWithFacts.has(id))
  }

  // Check 2: no duplicate persistence -- for each source document, no
  // (category, key, value) triple should appear more than once among its
  // own facts (a retry re-inserting the same extraction would produce
  // exactly this).
  const { data: allFacts, error: allFactsErr } = await supabase
    .from('project_facts')
    .select('id, source_document_id, category, key, value')
    .eq('job_id', JOB_ID)
    .not('source_document_id', 'is', null)
  if (allFactsErr) {
    console.error(JSON.stringify({ event: 'project_facts_full_read_failed', error: allFactsErr.message }))
    process.exit(1)
  }

  const seen = new Map()
  const duplicateGroups = []
  for (const f of allFacts ?? []) {
    const key = `${f.source_document_id}::${f.category}::${f.key}::${f.value}`
    if (!seen.has(key)) {
      seen.set(key, [f.id])
    } else {
      seen.get(key).push(f.id)
    }
  }
  for (const [key, ids] of Array.from(seen.entries())) {
    if (ids.length > 1) duplicateGroups.push({ key, fact_ids: ids })
  }

  const noFalseSuccess = orphanedCompleteDocIds.length === 0
  const noDuplicatePersistence = duplicateGroups.length === 0
  const ok = noFalseSuccess && noDuplicatePersistence

  console.log(JSON.stringify({
    event: ok ? 'check_passed' : 'check_FAILED',
    name: 'document_classification_persistence_truthfulness',
    total_documents: (docs ?? []).length,
    complete_documents: completeDocIds.length,
    orphaned_complete_doc_ids: orphanedCompleteDocIds,
    no_false_success: noFalseSuccess,
    total_facts: (allFacts ?? []).length,
    duplicate_fact_groups: duplicateGroups,
    no_duplicate_persistence: noDuplicatePersistence,
  }))

  process.exit(ok ? 0 : 1)
}

main()
