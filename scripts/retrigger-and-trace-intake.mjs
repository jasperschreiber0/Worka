#!/usr/bin/env node
// ONE-TIME follow-up: the first verification run's SSE reader went silent
// after ~12s of "queued" messages with no job_intake_locks row ever
// observed to exist, and no document_processing_batches row was ever
// created for the whole 12-minute poll window. Re-triggers intake for the
// SAME already-uploaded files (no need to re-upload again) and traces the
// raw HTTP response + every raw SSE chunk + tight early DB polling to catch
// exactly where it stalls this time.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const APP_URL = (process.env.APP_URL || '').replace(/\/$/, '')
const JOB_ID = '1f12de7f-47b5-442e-9581-1f813796eb70'
const PRIMARY_FILE_ID = '97f68c9e-e9b1-4cac-82da-27a30c9c904c' // DA-Mod, from the prior run's re-upload
const SIBLING_IDS = [
  '60176669-776e-4059-a390-ba6df34f7013',
  'aa1a7577-811c-4459-9905-20a10f7f8d55',
  '2a260abe-9e91-44c9-8992-9d7441253fee',
  '48e896d3-5975-41af-9fd0-4cf2eb8fe9da',
  '806209b8-5b12-453b-8bbe-cc8e0b3ffd3d',
  '00cbd0f8-34bc-42a3-b3b4-481cf70df43f',
]

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }

async function main() {
  const { data: quoteRow } = await supabase.from('quotes').select('builder_id').eq('job_id', JOB_ID).limit(1).maybeSingle()
  const builderId = quoteRow.builder_id

  // Confirm current state right before triggering.
  const { data: lockBefore } = await supabase.from('job_intake_locks').select('*').eq('job_id', JOB_ID).maybeSingle()
  const { data: fileBefore } = await supabase.from('files').select('id, intake_status, processing_batch_id').eq('id', PRIMARY_FILE_ID).single()
  log('pre_trigger_state', { lock: lockBefore ?? null, primary_file: fileBefore })

  // job_id is REQUIRED (route.ts:375, no validation/fallback) -- see the
  // job_intake_locks investigation this fixes: omitting it produced
  // job_id:'' -> Postgres 22P02 -> HTTP 400 -> silently masked as "locked".
  const intakeUrl = `${APP_URL}/api/intake/${PRIMARY_FILE_ID}?job_id=${JOB_ID}&siblings=${SIBLING_IDS.join(',')}&started_at=${Date.now()}`
  const authHeaders = { Authorization: `Bearer ${SERVICE_ROLE_KEY}`, 'x-worka-builder-id': builderId }

  log('triggering', { url: intakeUrl })
  const res = await fetch(intakeUrl, { headers: authHeaders })
  log('http_response', { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()) })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    log('non_ok_response_body', { body: text.slice(0, 3000) })
    process.exit(1)
  }

  // Read raw chunks (not just 'data:' lines) alongside tight DB polling for
  // the first two minutes specifically, since that's where the prior run
  // appears to have stalled.
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let dbPollCount = 0
  const dbPollTimer = setInterval(async () => {
    dbPollCount++
    const { data: lock } = await supabase.from('job_intake_locks').select('*').eq('job_id', JOB_ID).maybeSingle()
    const { data: file } = await supabase.from('files').select('intake_status, processing_batch_id').eq('id', PRIMARY_FILE_ID).single()
    log('tight_db_poll', { n: dbPollCount, lock: lock ?? null, primary_file: file })
  }, 3_000)

  const readDeadline = Date.now() + 10 * 60_000
  try {
    while (Date.now() < readDeadline) {
      const { value, done } = await reader.read()
      if (done) {
        log('sse_stream_done')
        break
      }
      const text = decoder.decode(value, { stream: true })
      log('sse_raw_chunk', { text: text.slice(0, 2000) })
    }
  } catch (err) {
    log('sse_read_error', { error: err instanceof Error ? err.message : String(err) })
  } finally {
    clearInterval(dbPollTimer)
  }

  const { data: lockAfter } = await supabase.from('job_intake_locks').select('*').eq('job_id', JOB_ID).maybeSingle()
  const { data: fileAfter } = await supabase.from('files').select('id, intake_status, processing_batch_id, ai_failure_classification').eq('id', PRIMARY_FILE_ID).single()
  const { data: batchAfter } = fileAfter.processing_batch_id
    ? await supabase.from('document_processing_batches').select('*').eq('id', fileAfter.processing_batch_id).maybeSingle()
    : { data: null }
  log('final_check', { lock: lockAfter ?? null, primary_file: fileAfter, batch: batchAfter ?? null })
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
