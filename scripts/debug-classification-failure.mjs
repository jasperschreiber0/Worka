#!/usr/bin/env node
// Temporary, one-off diagnostic — NOT part of the checked-in health-check
// suite. Runs the same real upload -> document-worker -> smooth-responder
// flow as scripts/synthetic-intake-health-check.mjs (setup code copied
// verbatim from that proven-working script, not re-guessed), but skips
// cleanup and prints the actual failure_reason/ai_failure_classification
// columns so we can see WHY a real run's classification ended in 'failed'
// instead of 'extracted' — the plain health check doesn't fetch or print
// those fields, and its own finally block deletes the row before anyone can
// look.
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
const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

// Copied verbatim from scripts/synthetic-intake-health-check.mjs — a
// byte-accurate minimal PDF with real xref offsets and real text content.
function buildSyntheticPdf() {
  const text = [
    'BT /F1 18 Tf 72 720 Td (WorkA synthetic health-check document.) Tj',
    '0 -24 Td (Single storey renovation, 100m2 floor area, VIC.) Tj',
    '0 -24 Td (Scope: kitchen renovation only. No structural work.) Tj ET',
  ].join('\n')

  const objects = []
  objects[1] = '<< /Type /Catalog /Pages 2 0 R >>'
  objects[2] = '<< /Type /Pages /Kids [3 0 R] /Count 1 >>'
  objects[3] = '<< /Type /Page /Parent 2 0 R /Resources << /Font << /F1 4 0 R >> >> /MediaBox [0 0 612 792] /Contents 5 0 R >>'
  objects[4] = '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'
  objects[5] = `<< /Length ${Buffer.byteLength(text, 'utf8')} >>\nstream\n${text}\nendstream`

  let body = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 1; i <= 5; i++) {
    offsets[i] = Buffer.byteLength(body, 'utf8')
    body += `${i} 0 obj\n${objects[i]}\nendobj\n`
  }

  const xrefOffset = Buffer.byteLength(body, 'utf8')
  let xref = `xref\n0 6\n0000000000 65535 f \n`
  for (let i = 1; i <= 5; i++) {
    xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  const trailer = `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

  return Buffer.from(body + xref + trailer, 'utf8')
}

async function main() {
  const jobId = crypto.randomUUID()
  const runTag = new Date().toISOString()
  const storagePath = `health-check/${jobId}/synthetic.pdf`

  await supabase.from('builders').upsert(
    { id: BUILDER_ID, email: 'health-check@getworka.com', name: 'Synthetic Health Check' },
    { onConflict: 'id', ignoreDuplicates: true }
  )

  const { error: jobErr } = await supabase.from('jobs').insert({
    id: jobId,
    builder_id: BUILDER_ID,
    address: `DEBUG DIAGNOSTIC — synthetic, safe to delete (${runTag})`,
    status: 'quoting',
    job_type: 'health_check',
  })
  if (jobErr) throw new Error(`job insert failed: ${jobErr.message}`)

  const pdfBuffer = buildSyntheticPdf()
  const { error: uploadErr } = await supabase.storage
    .from('plans')
    .upload(storagePath, pdfBuffer, { contentType: 'application/pdf', upsert: true })
  if (uploadErr) throw new Error(`storage upload failed: ${uploadErr.message}`)

  const { data: fileRow, error: fileErr } = await supabase
    .from('files')
    .insert({
      job_id: jobId, builder_id: BUILDER_ID, storage_path: storagePath,
      filename: 'synthetic.pdf', file_type: 'pdf', intake_status: 'uploaded',
    })
    .select()
    .single()
  if (fileErr || !fileRow) throw new Error(`files insert failed: ${fileErr?.message ?? 'no row returned'}`)
  log('uploaded', { job_id: jobId, file_id: fileRow.id })

  const { data: batchRow, error: batchErr } = await supabase
    .from('document_processing_batches')
    .insert({ job_id: jobId, builder_id: BUILDER_ID, primary_file_id: fileRow.id, status: 'running' })
    .select()
    .single()
  if (batchErr || !batchRow) throw new Error(`batch insert failed: ${batchErr?.message ?? 'no row returned'}`)

  const { error: jobsInsertErr } = await supabase
    .from('document_processing_jobs')
    .insert({ parent_job_id: batchRow.id, document_id: fileRow.id })
  if (jobsInsertErr) throw new Error(`document_processing_jobs insert failed: ${jobsInsertErr.message}`)

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
  // row every time it changes (not just the final one) so we can see the
  // failure classification the moment it appears.
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

  const { data: docJobs } = await supabase.from('document_processing_jobs')
    .select('status, error_message, attempts').eq('parent_job_id', batchRow.id)
  log('document_processing_jobs', { rows: docJobs })

  const { data: batch } = await supabase.from('document_processing_batches')
    .select('status, classification_triggered, stall_stage, stall_reason, stalled_at, stall_count, scope_reasoning_completed_at')
    .eq('id', batchRow.id).single()
  log('batch_final', batch)

  console.log('')
  console.log('--- NOT cleaned up. To delete this debug job manually, run: ---')
  console.log(`node -e "const{createClient}=require('@supabase/supabase-js');const s=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY);s.from('files').delete().eq('job_id','${jobId}').then(()=>s.from('jobs').delete().eq('id','${jobId}')).then(()=>console.log('cleaned up'))"`)
}

main().catch((err) => {
  console.error('FAILED:', err.message)
  process.exit(1)
})
