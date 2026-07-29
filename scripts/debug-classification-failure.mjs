#!/usr/bin/env node
// Temporary, one-off diagnostic — NOT part of the checked-in health-check
// suite. Runs the same real upload -> document-worker -> smooth-responder
// flow as scripts/synthetic-intake-health-check.mjs, but skips cleanup and
// prints the actual failure_reason/ai_failure_classification columns so we
// can see WHY a real run's classification ended in 'failed' instead of
// 'extracted' — the plain health check doesn't fetch or print those fields,
// and its own finally block deletes the row before anyone can look.
//
// Safe to run repeatedly: each run uses a fresh random job id. Prints a
// cleanup command at the end — this script does NOT delete anything itself.

import { createClient } from '@supabase/supabase-js'
import crypto from 'node:crypto'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !ANON_KEY) {
  console.error('NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, and NEXT_PUBLIC_SUPABASE_ANON_KEY must all be set')
  process.exit(1)
}

const BUILDER_ID = '00000000-0000-0000-0000-0000000000fe'
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, { auth: { persistSession: false } })

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

async function main() {
  const jobId = crypto.randomUUID()
  const storagePath = `debug/${jobId}.pdf`

  // A minimal but valid one-page PDF with real sentences (same shape as the
  // health-check script's synthetic fixture) — enough for Stage 1/2 to have
  // something to reason about.
  const pdfText = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/Resources<</Font<</F1 4 0 R>>>>/MediaBox[0 0 612 792]/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 200>>
stream
BT /F1 12 Tf 50 700 Td (Residential renovation, single storey extension, kitchen and bathroom.) Tj
0 -20 Td (Site address: 42 Test Street, Sample VIC 3000. Floor area approx 45m2.) Tj
ET
endstream
endobj
xref
0 6
trailer<</Size 6/Root 1 0 R>>
startxref
0
%%EOF`

  const { error: uploadErr } = await supabase.storage.from('plans').upload(storagePath, Buffer.from(pdfText), { contentType: 'application/pdf' })
  if (uploadErr) throw new Error(`upload failed: ${uploadErr.message}`)

  const { error: jobErr } = await supabase.from('jobs').insert({
    id: jobId, builder_id: BUILDER_ID, address: 'Debug diagnostic job — safe to delete',
    status: 'quoting', job_type: 'renovation', notes: 'Temporary diagnostic job, safe to delete',
  })
  if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)

  const { data: fileRow, error: fileErr } = await supabase.from('files')
    .insert({ job_id: jobId, builder_id: BUILDER_ID, filename: 'debug.pdf', storage_path: storagePath, file_type: 'application/pdf', intake_status: 'uploaded' })
    .select('id').single()
  if (fileErr) throw new Error(`file insert failed: ${fileErr.message}`)
  log('uploaded', { job_id: jobId, file_id: fileRow.id })

  const { data: batchRow, error: batchErr } = await supabase.from('document_processing_batches')
    .insert({ job_id: jobId, builder_id: BUILDER_ID, primary_file_id: fileRow.id, status: 'running' })
    .select('id').single()
  if (batchErr) throw new Error(`batch insert failed: ${batchErr.message}`)

  await supabase.from('document_processing_jobs').insert({ parent_job_id: batchRow.id, document_id: fileRow.id })
  await supabase.from('files').update({ processing_batch_id: batchRow.id, intake_status: 'processing' }).eq('id', fileRow.id)
  log('batch_created', { job_id: jobId, batch_id: batchRow.id })

  const workerRes = await fetch(`${SUPABASE_URL}/functions/v1/document-worker`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${ANON_KEY}` },
    body: JSON.stringify({ parent_job_id: batchRow.id, builder_id: BUILDER_ID }),
  })
  if (!workerRes.ok) throw new Error(`document-worker invocation failed: HTTP ${workerRes.status} ${await workerRes.text().catch(() => '')}`)
  log('worker_invoked', { status: workerRes.status })

  // Poll files for a terminal intake_status, printing the full diagnostic
  // row every time (not just the final one) so we can see the failure
  // classification the moment it appears.
  const deadline = Date.now() + 240_000
  let lastPrinted = null
  while (Date.now() < deadline) {
    const { data: f } = await supabase.from('files')
      .select('intake_status, failure_reason, ai_failure_classification, ai_failure_count, intake_stage, intake_pct')
      .eq('id', fileRow.id).single()
    const snapshot = JSON.stringify(f)
    if (snapshot !== lastPrinted) {
      log('file_status', f)
      lastPrinted = snapshot
    }
    if (f && ['extracted', 'needs_info', 'failed'].includes(f.intake_status)) break
    await sleep(2000)
  }

  // Also check whether smooth-responder logged a stall (migration 053) on
  // this batch, and check document_processing_jobs for its own error_message.
  const { data: docJobs } = await supabase.from('document_processing_jobs')
    .select('status, error_message, attempts').eq('parent_job_id', batchRow.id)
  log('document_processing_jobs', { rows: docJobs })

  const { data: batch } = await supabase.from('document_processing_batches')
    .select('status, classification_triggered, stall_stage, stall_reason, stalled_at, stall_count, scope_reasoning_completed_at')
    .eq('id', batchRow.id).single()
  log('batch_final', batch)

  console.log('')
  console.log('--- NOT cleaned up. To delete this debug job manually, run: ---')
  console.log(`node -e "require('@supabase/supabase-js').createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY).from('files').delete().eq('job_id','${jobId}').then(()=>require('@supabase/supabase-js').createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY).from('jobs').delete().eq('id','${jobId}')).then(()=>console.log('cleaned up'))"`)
}

main().catch((err) => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
