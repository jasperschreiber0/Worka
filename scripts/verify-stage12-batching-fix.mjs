#!/usr/bin/env node
// ============================================================
// ONE-TIME production verification (not a recurring diagnostic) — re-uploads
// the same 7 real files to the real, existing job 1f12de7f-47b5-442e-9581-
// 1f813796eb70 through the REAL production routes (POST /api/upload, PUT to
// the signed Storage URL, GET /api/intake/[fileId]?siblings=...) exactly as
// the browser does, then traces the new document_processing_batches/jobs/
// ai_operations rows in the DB to prove (or disprove) that the deployed
// solo-routing fix (shouldRouteSoloForVisionLoad) actually isolates the
// DA-Mod PDF into its own batch on this run, rather than inferring it from
// call duration alone.
//
// Uses the trusted-internal-caller path getAuthenticatedBuilderId() already
// supports (Authorization: Bearer <SERVICE_ROLE_KEY> + x-worka-builder-id) —
// the SAME code path a real browser session reaches via cookie auth, not a
// raw DB write of fabricated pipeline state. No timeout/config/DB-state
// changes are made; the only writes this script performs are the exact
// files/document_processing_batches/document_processing_jobs inserts that
// POST /api/upload and GET /api/intake/[fileId] themselves perform.
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = (process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL || '').replace(/\/$/, '')

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL must all be set' }))
  process.exit(1)
}

const JOB_ID = '1f12de7f-47b5-442e-9581-1f813796eb70'
// The original 2026-08-21 upload's 7 file rows — canonical source of the
// real bytes (content_hash-identical to every later re-upload attempt).
const SOURCE_FILE_IDS = [
  '2be51517-e0c0-4de1-9d2f-7e8f65bfca4a', // Butler's Pantry Elevations
  '9ab130a8-0da8-468f-98d5-075ab6611cb1', // Kitchen Elevation
  'f19fdbcd-a3db-40b7-9c9b-b722b62d8d6a', // DRAFT Fittings/Fixture/Appliances
  'b6e5892c-85b4-4202-8720-5ef9d669f4ef', // Electrical First Draft
  '9b10e30d-6a94-4377-bc26-eb6a9c3c2b0d', // DRAFT Materials + Finishes
  '26b21b05-7f6f-49e5-bbe8-8cee66ea3560', // 16 Alfred Street Woonona DA-Mod  <- target document
  '86b00cee-9e73-4c33-9cec-7884eb4dc9ec', // Structurals
]
const DA_MOD_SOURCE_ID = '26b21b05-7f6f-49e5-bbe8-8cee66ea3560'

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function main() {
  const runStartedAt = new Date().toISOString()

  const { data: quoteRow } = await supabase.from('quotes').select('builder_id').eq('job_id', JOB_ID).limit(1).maybeSingle()
  const builderId = quoteRow?.builder_id
  if (!builderId) {
    log('builder_lookup_failed', { job_id: JOB_ID })
    process.exit(1)
  }
  log('resolved_builder', { builder_id: builderId })

  // Baseline, read BEFORE re-upload, for later comparison.
  const { data: baselineDocs } = await supabase.from('project_documents').select('id').eq('job_id', JOB_ID)
  const { data: baselineQuote } = await supabase.from('quotes').select('id, status, total_cost, overall_confidence, is_current').eq('job_id', JOB_ID).eq('is_current', true).maybeSingle()
  log('baseline_state', { project_documents_count: baselineDocs?.length ?? 0, quote: baselineQuote ?? null })

  const authHeaders = {
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    'x-worka-builder-id': builderId,
    'Content-Type': 'application/json',
  }

  // ── 1. Re-upload each of the 7 source files via the REAL /api/upload route ──
  const { data: sourceFiles, error: sourceErr } = await supabase
    .from('files')
    .select('id, filename, file_type, storage_path, file_size_bytes')
    .in('id', SOURCE_FILE_IDS)
  if (sourceErr || !sourceFiles || sourceFiles.length !== SOURCE_FILE_IDS.length) {
    log('source_files_lookup_failed', { error: sourceErr?.message, found: sourceFiles?.length ?? 0, expected: SOURCE_FILE_IDS.length })
    process.exit(1)
  }

  const newFiles = []
  for (const src of sourceFiles) {
    const { data: blob, error: dlErr } = await supabase.storage.from('plans').download(src.storage_path)
    if (dlErr || !blob) {
      log('source_download_failed', { source_file_id: src.id, filename: src.filename, error: dlErr?.message })
      process.exit(1)
    }
    const buffer = Buffer.from(await blob.arrayBuffer())

    const uploadRes = await fetch(`${APP_URL}/api/upload`, {
      method: 'POST',
      headers: authHeaders,
      body: JSON.stringify({ job_id: JOB_ID, filename: src.filename, content_type: 'application/pdf', size: buffer.byteLength }),
    })
    if (!uploadRes.ok) {
      log('upload_route_failed', { source_file_id: src.id, filename: src.filename, status: uploadRes.status, body: await uploadRes.text().catch(() => '') })
      process.exit(1)
    }
    const uploadBody = await uploadRes.json()
    const newFileId = uploadBody.file?.id
    const uploadUrl = uploadBody.upload_url
    if (!newFileId || !uploadUrl) {
      log('upload_route_bad_response', { source_file_id: src.id, body: uploadBody })
      process.exit(1)
    }

    const putRes = await fetch(uploadUrl, { method: 'PUT', headers: { 'Content-Type': 'application/pdf' }, body: buffer })
    if (!putRes.ok) {
      log('storage_put_failed', { source_file_id: src.id, new_file_id: newFileId, status: putRes.status })
      process.exit(1)
    }

    newFiles.push({ sourceId: src.id, newId: newFileId, filename: src.filename, bytes: buffer.byteLength })
    log('file_reuploaded', { source_file_id: src.id, new_file_id: newFileId, filename: src.filename, bytes: buffer.byteLength })
  }

  const daModNew = newFiles.find((f) => f.sourceId === DA_MOD_SOURCE_ID)
  const primary = daModNew // any file can be primary for the SSE trigger; use DA-Mod itself
  const siblingIds = newFiles.filter((f) => f.newId !== primary.newId).map((f) => f.newId)
  log('reupload_complete', { primary_new_file_id: primary.newId, sibling_ids: siblingIds, da_mod_new_file_id: daModNew.newId })

  // ── 2. Trigger the real pipeline via GET /api/intake/[fileId]?siblings=... ──
  const intakeUrl = `${APP_URL}/api/intake/${primary.newId}?siblings=${siblingIds.join(',')}&started_at=${Date.now()}`
  log('triggering_intake', { url: intakeUrl })
  const sseController = new AbortController()
  const ssePromise = (async () => {
    try {
      const res = await fetch(intakeUrl, { headers: authHeaders, signal: sseController.signal })
      if (!res.ok || !res.body) {
        log('sse_connect_failed', { status: res.status })
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      const deadline = Date.now() + 5 * 60_000 // read the stream for up to 5 minutes, then stop reading (server-side work continues independently — see header comment)
      while (Date.now() < deadline) {
        const { value, done } = await reader.read()
        if (done) break
        const text = decoder.decode(value, { stream: true })
        for (const line of text.split('\n')) {
          if (line.startsWith('data:')) log('sse_event', { data: line.slice(5).trim().slice(0, 1000) })
        }
      }
      reader.cancel().catch(() => {})
    } catch (err) {
      log('sse_stream_error', { error: err instanceof Error ? err.message : String(err) })
    }
  })()

  // Give the SSE connection a head start to actually create the batch before we start polling.
  await sleep(5_000)

  // ── 3. Poll the DB directly for the real batch/job/ai_operations evidence ──
  const POLL_INTERVAL_MS = 5_000
  const POLL_DEADLINE = Date.now() + 12 * 60_000 // up to 12 minutes: one 340s invocation + margin for a possible recovery-cron resume
  let daModBatchId = null
  let lastSnapshot = null
  while (Date.now() < POLL_DEADLINE) {
    const { data: daModFileRow } = await supabase
      .from('files')
      .select('id, intake_status, ai_failure_classification, ai_failure_count, processing_batch_id')
      .eq('id', daModNew.newId)
      .single()

    if (daModFileRow?.processing_batch_id) daModBatchId = daModFileRow.processing_batch_id

    let batchRow = null
    let batchSiblingDocIds = []
    if (daModBatchId) {
      const { data: b } = await supabase
        .from('document_processing_batches')
        .select('id, status, classification_triggered, quote_id, created_at, updated_at, stall_stage, stall_reason, scope_reasoning_completed_at')
        .eq('id', daModBatchId)
        .maybeSingle()
      batchRow = b
      const { data: jobsInBatch } = await supabase
        .from('document_processing_jobs')
        .select('document_id, status')
        .eq('parent_job_id', daModBatchId)
      batchSiblingDocIds = (jobsInBatch ?? []).map((j) => j.document_id)
    }

    const { data: newOps } = await supabase
      .from('ai_operations')
      .select('id, call_site, status, cost_cents, error_classification, created_at')
      .like('scope_key', `${JOB_ID}:%`)
      .gte('created_at', runStartedAt)
      .order('created_at', { ascending: true })

    const snapshot = JSON.stringify({ daModFileRow, batchRow, batchSiblingDocIds, newOps })
    if (snapshot !== lastSnapshot) {
      lastSnapshot = snapshot
      log('poll_snapshot', {
        da_mod_file: daModFileRow,
        da_mod_batch: batchRow,
        da_mod_batch_document_ids: batchSiblingDocIds,
        da_mod_batch_is_solo: batchRow ? batchSiblingDocIds.length === 1 && batchSiblingDocIds[0] === daModNew.newId : null,
        ai_operations_since_run_start: newOps,
      })
    }

    if (daModFileRow?.intake_status && ['extracted', 'needs_info', 'failed'].includes(daModFileRow.intake_status)) {
      log('da_mod_reached_terminal_status', { status: daModFileRow.intake_status })
      break
    }

    await sleep(POLL_INTERVAL_MS)
  }

  sseController.abort()
  await ssePromise.catch(() => {})

  // ── 4. Final state dump for the report — DA-Mod, the other 6, project_documents, quote ──
  const { data: allNewFiles } = await supabase
    .from('files')
    .select('id, filename, intake_status, intake_stage, intake_pct, ai_failure_classification, ai_failure_count, processing_batch_id')
    .in('id', newFiles.map((f) => f.newId))
  const { data: finalOps } = await supabase
    .from('ai_operations')
    .select('id, call_site, status, cost_cents, error_classification, created_at')
    .like('scope_key', `${JOB_ID}:%`)
    .gte('created_at', runStartedAt)
    .order('created_at', { ascending: true })
  const { data: finalDocs } = await supabase.from('project_documents').select('id, file_id, extraction_status, document_type, created_at').eq('job_id', JOB_ID)
  const { data: finalFacts } = await supabase.from('project_facts').select('id, superseded').eq('job_id', JOB_ID)
  const { data: finalQuote } = await supabase.from('quotes').select('id, status, total_cost, overall_confidence, is_current, version').eq('job_id', JOB_ID).eq('is_current', true).maybeSingle()

  log('final_state', {
    new_files: allNewFiles,
    ai_operations_since_run_start: finalOps,
    project_documents_count: finalDocs?.length ?? 0,
    project_documents: finalDocs,
    project_facts_total: finalFacts?.length ?? 0,
    project_facts_active: (finalFacts ?? []).filter((f) => !f.superseded).length,
    current_quote: finalQuote,
    baseline_quote_for_comparison: baselineQuote ?? null,
    baseline_project_documents_count: baselineDocs?.length ?? 0,
  })

  log('done', { job_id: JOB_ID, da_mod_new_file_id: daModNew.newId, da_mod_batch_id: daModBatchId })
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
