/**
 * document-worker — one Edge Function invocation, one document.
 *
 * This exists to give each uploaded document its own, genuinely isolated
 * Supabase CPU-time budget (2000ms, metered per REQUEST — see Supabase's
 * own CPU-limits docs). Previously every document in an upload shared ONE
 * smooth-responder invocation's budget for text extraction; a single
 * expensive PDF (complex embedded fonts, malformed objects) could exhaust
 * it and kill the isolate outright, taking every other document in that
 * batch down with it — an external, uncatchable kill that no try/catch or
 * timeout inside that shared invocation could ever prevent (see
 * gateTextExtraction in pipeline-logic.ts for the incident this replaced).
 *
 * Flow, one document per HTTP request:
 *   claim_next_document_job (atomic, FOR UPDATE SKIP LOCKED — migration 034)
 *     -> load the document from storage
 *     -> extract text (gated exactly like before, still a real safeguard,
 *        just no longer the ONLY line of defense)
 *     -> persist the result (complete_document_job) or schedule a retry /
 *        mark permanently failed (retry_or_fail_document_job)
 *     -> trigger the next pending job for this batch with a fresh
 *        invocation (this is what gives it a fresh CPU budget — a
 *        same-invocation loop would not)
 *     -> if this was the last child job to finish, trigger the
 *        classification/estimate stage (smooth-responder) exactly once
 */

import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { extractPdfTextGated, hasUsableText, isTextDense } from '../smooth-responder/pdf-text.ts'
import { getPdfPageCount } from '../smooth-responder/pdf-chunk.ts'

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

// Matches the shape smooth-responder's classification stage expects when
// building Claude message content from a completed job — see
// loadBlockFromExtractionResult in smooth-responder/index.ts.
interface ExtractionResult {
  blockType: 'text_only' | 'vision_only' | 'image' | 'csv'
  text: string | null
  hasUsableText: boolean
  pageCount: number | null
  durationMs: number
}

function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

interface DocumentJobRow {
  id: string
  parent_job_id: string
  document_id: string
  attempts: number
}

async function processOneDocument(
  supabase: SupabaseClient,
  job: DocumentJobRow,
  builderId: string
): Promise<{ outcome: 'completed' | 'retry' | 'failed'; result?: ExtractionResult; error?: string }> {
  const { data: fileRow } = await supabase
    .from('files')
    .select('*')
    .eq('id', job.document_id)
    .eq('builder_id', builderId)
    .single()

  if (!fileRow) {
    return { outcome: 'failed', error: 'File record not found or does not belong to builder' }
  }

  console.log(JSON.stringify({
    event: 'worker_claimed_job', job_id: job.id, document_id: job.document_id,
    filename: fileRow.filename, attempt: job.attempts + 1,
  }))

  const processStartedAt = Date.now()
  try {
    const { data: fileData, error: downloadErr } = await supabase.storage
      .from('plans')
      .download(fileRow.storage_path)
    if (downloadErr || !fileData) {
      throw new Error(`Storage download failed: ${downloadErr?.message ?? 'no data returned'}`)
    }

    const buffer = await fileData.arrayBuffer()
    const isPdf = fileRow.file_type === 'pdf'
    const isCsv = fileRow.file_type === 'other' && /\.csv$/i.test(fileRow.filename ?? '')

    let result: ExtractionResult

    if (isCsv) {
      const text = atob(toBase64(buffer)).slice(0, 40000)
      result = { blockType: 'csv', text, hasUsableText: true, pageCount: null, durationMs: 0 }
    } else if (isPdf) {
      const rawBytes = new Uint8Array(buffer)
      let pageCount: number | null = null
      try {
        pageCount = await getPdfPageCount(rawBytes)
      } catch {
        pageCount = null
      }

      console.log(JSON.stringify({
        event: 'extraction_start', document_id: job.document_id, filename: fileRow.filename,
        size: buffer.byteLength, page_count: pageCount,
      }))
      const base64 = toBase64(buffer)
      // Single document per invocation, so cumulative spend starts at 0 —
      // the gate still applies (a single pathologically complex file can
      // still exceed the run-wide ceiling on its own), it just no longer
      // has to account for OTHER documents' spend in the same invocation,
      // since there are none.
      const { text, skippedReason, durationMs } = await extractPdfTextGated(base64, buffer.byteLength, pageCount, 0)
      console.log(JSON.stringify({
        event: 'extraction_complete', document_id: job.document_id, filename: fileRow.filename,
        extraction_cpu_duration: durationMs, skipped_reason: skippedReason ?? undefined, text_length: text.length,
      }))
      if (skippedReason) {
        console.log(JSON.stringify({ event: 'extraction_skipped', document_id: job.document_id, filename: fileRow.filename, reason: skippedReason }))
      }

      const dense = isTextDense(text)
      const usable = hasUsableText(text)
      result = {
        blockType: dense ? 'text_only' : 'vision_only',
        text: dense || usable ? text : null,
        hasUsableText: usable,
        pageCount,
        durationMs,
      }
      console.log(JSON.stringify({
        event: 'fallback_decision', document_id: job.document_id, filename: fileRow.filename,
        decision: dense ? 'text_only' : (usable ? 'vision_plus_text_supplement' : 'vision_only'),
      }))
    } else {
      result = { blockType: 'image', text: null, hasUsableText: false, pageCount: null, durationMs: 0 }
    }

    console.log(JSON.stringify({
      event: 'document_processing_duration', document_id: job.document_id, filename: fileRow.filename,
      duration_ms: Date.now() - processStartedAt,
    }))
    return { outcome: 'completed', result }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    console.log(JSON.stringify({
      event: 'worker_failed', job_id: job.id, document_id: job.document_id,
      filename: fileRow.filename, attempt: job.attempts + 1,
      duration_ms: Date.now() - processStartedAt, error: message,
    }))
    return { outcome: job.attempts + 1 >= 3 ? 'failed' : 'retry', error: message }
  }
}

async function triggerNext(edgeFnUrl: string, anonKey: string, parentJobId: string, builderId: string, delayMs: number): Promise<void> {
  if (delayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, delayMs))
  }
  try {
    await fetch(`${edgeFnUrl}/document-worker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ parent_job_id: parentJobId, builder_id: builderId }),
    })
  } catch (err) {
    console.error('document-worker: failed to trigger next job', err)
  }
}

async function triggerClassification(edgeFnUrl: string, anonKey: string, parentJobId: string): Promise<void> {
  try {
    await fetch(`${edgeFnUrl}/smooth-responder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ parent_job_id: parentJobId }),
    })
  } catch (err) {
    console.error('document-worker: failed to trigger classification', err)
  }
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anonKey = Deno.env.get('SUPABASE_ANON_KEY') ?? ''
  if (!supabaseUrl || !supabaseKey) {
    return new Response(JSON.stringify({ error: 'Missing environment variables' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  let body: { parent_job_id: string; builder_id: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }
  const { parent_job_id, builder_id } = body
  if (!parent_job_id || !builder_id) {
    return new Response(JSON.stringify({ error: 'parent_job_id, builder_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(supabaseUrl, supabaseKey)
  // Functions live at <project>/functions/v1/<name> — this invocation's own
  // URL already has that shape, so strip the last path segment to get the
  // shared base rather than hardcoding the project ref.
  const edgeFnBaseUrl = new URL(req.url)
  edgeFnBaseUrl.pathname = edgeFnBaseUrl.pathname.replace(/\/document-worker\/?$/, '')
  const edgeFnUrl = edgeFnBaseUrl.toString().replace(/\/$/, '')

  console.log(JSON.stringify({ event: 'worker_started', parent_job_id, builder_id }))

  const { data: claimed, error: claimErr } = await supabase.rpc('claim_next_document_job', { p_parent_job_id: parent_job_id })
  if (claimErr) {
    console.error('document-worker: claim_next_document_job failed', claimErr)
    return new Response(JSON.stringify({ status: 'error', error: claimErr.message }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const job = (claimed as DocumentJobRow[] | null)?.[0]
  if (!job) {
    // Nothing left to claim right now — either the batch is fully done, or
    // every remaining job is a scheduled retry not yet due. Either way,
    // this invocation has nothing to do and exits; a scheduled retry's own
    // delayed self-trigger (below, from whichever invocation last touched
    // it) is what wakes the chain back up.
    return new Response(JSON.stringify({ status: 'idle' }), { status: 200, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  EdgeRuntime.waitUntil((async () => {
    const outcome = await processOneDocument(supabase, job, builder_id)

    let shouldTriggerClassification = false
    let retryDelayMs = 0

    if (outcome.outcome === 'completed') {
      const { data, error } = await supabase.rpc('complete_document_job', { p_job_id: job.id, p_result: outcome.result })
      if (error) console.error('document-worker: complete_document_job failed', error)
      shouldTriggerClassification = Boolean(data?.[0]?.should_trigger_classification)
      console.log(JSON.stringify({ event: 'worker_completed', job_id: job.id, document_id: job.document_id, attempt: job.attempts + 1 }))
    } else {
      const { data, error } = await supabase.rpc('retry_or_fail_document_job', { p_job_id: job.id, p_error: outcome.error ?? 'unknown error' })
      if (error) console.error('document-worker: retry_or_fail_document_job failed', error)
      const row = data?.[0]
      shouldTriggerClassification = Boolean(row?.should_trigger_classification)
      if (outcome.outcome === 'retry' && row?.next_run_after) {
        retryDelayMs = Math.max(0, new Date(row.next_run_after).getTime() - Date.now())
        console.log(JSON.stringify({ event: 'worker_retry', job_id: job.id, document_id: job.document_id, attempt: job.attempts + 1, retry_delay_ms: retryDelayMs }))
      }
    }

    // Immediately try to claim whatever else is ready now (covers sibling
    // documents in the same batch) — this is what turns a single claim
    // into a self-sustaining chain, each hop a fresh invocation/CPU budget.
    await triggerNext(edgeFnUrl, anonKey, parent_job_id, builder_id, 0)

    // This specific job may have just been scheduled for a delayed retry —
    // also wake the chain up specifically at that delay, in case by then
    // every sibling is already done and this is the only job left.
    if (retryDelayMs > 0) {
      await triggerNext(edgeFnUrl, anonKey, parent_job_id, builder_id, retryDelayMs)
    }

    if (shouldTriggerClassification) {
      await triggerClassification(edgeFnUrl, anonKey, parent_job_id)
    }
  })())

  return new Response(JSON.stringify({ status: 'claimed', job_id: job.id, document_id: job.document_id }), {
    status: 202,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
