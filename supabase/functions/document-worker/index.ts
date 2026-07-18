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
  builderId: string,
  workerId: string
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
      } catch (pageCountErr) {
        // TEMPORARY DIAGNOSTIC LOGGING — this catch already fails gracefully
        // (falls back to pageCount = null, processing continues normally),
        // but it previously did so completely silently: a malformed PDF
        // (pdf-lib throwing e.g. "Invalid object ref: N 0 R" / "Trying to
        // parse invalid object" on a broken xref table) left zero trace that
        // anything was ever wrong with this specific file. getPdfPageCount
        // uses pdf-lib, a separate pure-JS parser from unpdf/pdf.js below —
        // these are ordinary catchable exceptions, not the uncatchable
        // CPU-governor kill pdf.js's font interpreter can trigger.
        pageCount = null
        console.log(JSON.stringify({
          event: 'page_count_failed', document_id: job.document_id, filename: fileRow.filename,
          attempt: job.attempts + 1,
          error: pageCountErr instanceof Error ? pageCountErr.message : String(pageCountErr),
        }))
      }

      console.log(JSON.stringify({
        event: 'extraction_start', worker_id: workerId, document_id: job.document_id, filename: fileRow.filename,
        size: buffer.byteLength, page_count: pageCount, attempt: job.attempts + 1,
      }))
      const base64 = toBase64(buffer)
      // Retry safeguard: attempts >= 1 means a PRIOR attempt on this exact
      // document already failed — and the failure mode that matters here is
      // the one no gate heuristic can prevent: pdf.js's font interpreter
      // CPU-killing the isolate mid-parse (external, uncatchable — the row
      // was left at 'running' and reclaimed by staleness, which is precisely
      // what incremented attempts). Byte size and page count demonstrably do
      // NOT predict this (the documented incident file was ~290KB — see
      // pdf-text.ts's header), so re-attempting the identical extraction on
      // a retry just reproduces the identical crash: a deterministic crash
      // LOOP, burning all 3 attempts on the same kill and stalling the whole
      // batch for the builder each cycle. Text extraction is an optimization
      // (better numeric fidelity for priced tables, cheaper tokens for
      // text-dense specs) — never a requirement; the vision path processes
      // the document fully without it. So on any retry, skip extraction
      // outright and go vision-only: attempt 2 is then guaranteed not to
      // die in the parser, converting "crash loop until permanently failed"
      // into "processed successfully with slightly lower text fidelity".
      const retrySafeguard = job.attempts >= 1
      if (retrySafeguard) {
        console.log(JSON.stringify({
          event: 'extraction_skipped_retry_safeguard', worker_id: workerId, document_id: job.document_id,
          filename: fileRow.filename, attempt: job.attempts + 1,
          reason: 'prior attempt on this document failed (likely uncatchable CPU-kill mid-extraction) — processing vision-only, no text-layer parse',
        }))
      }
      // Single document per invocation, so cumulative spend starts at 0 —
      // the gate still applies (a single pathologically complex file can
      // still exceed the run-wide ceiling on its own), it just no longer
      // has to account for OTHER documents' spend in the same invocation,
      // since there are none.
      const { text, skippedReason, durationMs } = retrySafeguard
        ? { text: '', skippedReason: 'retry safeguard — prior attempt crashed, text-layer extraction not re-attempted', durationMs: 0 }
        : await extractPdfTextGated(base64, buffer.byteLength, pageCount, 0)
      console.log(JSON.stringify({
        event: 'extraction_complete', document_id: job.document_id, filename: fileRow.filename,
        extraction_cpu_duration: durationMs, skipped_reason: skippedReason ?? undefined, text_length: text.length,
      }))
      // TEMPORARY DIAGNOSTIC LOGGING — flags a single extraction call that
      // took an unusually long time, named by document_id + filename so a
      // hanging/pathological PDF is identifiable from logs alone rather than
      // inferred from an aggregate queue-stuck symptom. Does not change
      // control flow: extractPdfTextGated already returned by this point
      // (this can only ever fire on a genuinely slow-but-completed call —
      // it cannot catch a call that never returns because the isolate was
      // externally CPU-killed mid-parse; see this file's own retry-safeguard
      // comment above for why no in-process timeout can do that).
      if (durationMs > 30_000) {
        console.log(JSON.stringify({
          event: 'extraction_slow', document_id: job.document_id, filename: fileRow.filename,
          extraction_cpu_duration: durationMs, threshold_ms: 30_000,
        }))
      }
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

    const totalDurationMs = Date.now() - processStartedAt
    console.log(JSON.stringify({
      event: 'document_processing_duration', document_id: job.document_id, filename: fileRow.filename,
      duration_ms: totalDurationMs,
    }))
    // TEMPORARY DIAGNOSTIC LOGGING — same 30s threshold, but on the whole
    // per-document invocation (download + page count + extraction +
    // fallback decision), not just the text-extraction call — catches a
    // slow Storage download or a slow getPdfPageCount too, not only a slow
    // extractPdfTextGated call.
    if (totalDurationMs > 30_000) {
      console.log(JSON.stringify({
        event: 'document_processing_slow', document_id: job.document_id, filename: fileRow.filename,
        duration_ms: totalDurationMs, threshold_ms: 30_000, attempt: job.attempts + 1,
      }))
    }
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
    const res = await fetch(`${edgeFnUrl}/document-worker`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ parent_job_id: parentJobId, builder_id: builderId }),
    })
    // fetch() does NOT throw on a non-2xx response (a 401/403/500 resolves
    // normally) — previously only a network-level failure (thrown before
    // ever getting a response) was ever logged, so a REJECTED self-chain
    // call (e.g. an auth mismatch on this function's own SUPABASE_ANON_KEY
    // secret vs. whatever key the ORIGINAL upload-triggered invocation
    // used) failed completely silently: no error anywhere, the chain just
    // stopped, indistinguishable in the logs from "batch genuinely done."
    // This is exactly the shape of a real incident — always precisely the
    // first WORKER_CONCURRENCY documents succeed and nothing beyond them
    // ever does.
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(JSON.stringify({
        event: 'trigger_next_rejected', parent_job_id: parentJobId,
        status: res.status, body: bodyText.slice(0, 500),
      }))
    }
  } catch (err) {
    console.error('document-worker: failed to trigger next job', err)
  }
}

async function triggerClassification(edgeFnUrl: string, anonKey: string, parentJobId: string): Promise<void> {
  try {
    const res = await fetch(`${edgeFnUrl}/smooth-responder`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
      body: JSON.stringify({ parent_job_id: parentJobId }),
    })
    // See triggerNext's comment above — fetch() doesn't throw on a
    // rejected response, so this was previously silent too.
    if (!res.ok) {
      const bodyText = await res.text().catch(() => '')
      console.error(JSON.stringify({
        event: 'trigger_classification_rejected', parent_job_id: parentJobId,
        status: res.status, body: bodyText.slice(0, 500),
      }))
    }
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
  // Root cause of a real production freeze: this used to derive the base
  // URL by parsing req.url and stripping "/document-worker" off the end,
  // on the assumption that req.url has the same
  // "<project>/functions/v1/<name>" shape external callers use. It
  // doesn't — Supabase's edge runtime hands the function a req.url that
  // does NOT include the "/functions/v1/" prefix the gateway itself
  // requires for routing, so every self-chained call
  // (triggerNext/triggerClassification) was silently hitting a malformed
  // URL and getting back 404 "requested path is invalid" — a rejected
  // response, not a thrown exception, so the old code (which only caught
  // network-level throws) never logged anything either. This is exactly
  // why only the ORIGINAL WORKER_CONCURRENCY invocations (fired by
  // app/api/intake/[fileId]/route.ts and the recovery cron, both of which
  // already hardcode this same "${supabaseUrl}/functions/v1" shape) ever
  // ran — nothing self-chained beyond them. Use the same hardcoded,
  // proven-correct construction every other caller in this codebase
  // already uses, instead of trying to reconstruct it from the request.
  const edgeFnUrl = `${supabaseUrl}/functions/v1`

  // Random per-invocation id, not tied to any infrastructure identifier —
  // purely so structured logs and document_processing_jobs.locked_by can be
  // correlated across the several log lines one invocation emits, and so a
  // stuck_document_jobs row found later in an incident can be traced back to
  // which invocation (crashed one) last touched it.
  const workerId = crypto.randomUUID()
  const invocationStartedAt = Date.now()

  console.log(JSON.stringify({ event: 'worker_started', worker_id: workerId, parent_job_id, builder_id }))

  const { data: claimed, error: claimErr } = await supabase.rpc('claim_next_document_job', { p_parent_job_id: parent_job_id, p_worker_id: workerId })
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
    // This whole callback is where the failure mode migration 034/036/037
    // exist for actually happens: if it's killed externally (Supabase's
    // CPU-time governor) partway through, NOTHING below this point runs —
    // no catch, no finally, no triggerNext. That's not fixable from inside
    // this function (an uncatchable kill is, by definition, uncatchable);
    // the defense is structural — app/api/cron/intake-recovery/route.ts
    // independently notices this job never left 'running' and both
    // reclaims it AND re-fires a fresh document-worker invocation, with no
    // dependency on this callback (or any sibling invocation) still being
    // alive. The try/catch below only guards against a genuinely catchable
    // exception in this callback's OWN logic (e.g. an unexpected throw from
    // a client call) so that case at least logs clearly instead of becoming
    // a silent unhandled rejection — it is not a substitute for the cron.
    try {
      const outcome = await processOneDocument(supabase, job, builder_id, workerId)

      let shouldTriggerClassification = false
      let retryDelayMs = 0

      if (outcome.outcome === 'completed') {
        const { data, error } = await supabase.rpc('complete_document_job', { p_job_id: job.id, p_result: outcome.result })
        if (error) console.error(JSON.stringify({ event: 'complete_document_job_rpc_failed', worker_id: workerId, job_id: job.id, error: error.message }))
        shouldTriggerClassification = Boolean(data?.[0]?.should_trigger_classification)
        console.log(JSON.stringify({ event: 'worker_completed', worker_id: workerId, job_id: job.id, document_id: job.document_id, attempt: job.attempts + 1 }))
      } else {
        const { data, error } = await supabase.rpc('retry_or_fail_document_job', { p_job_id: job.id, p_error: outcome.error ?? 'unknown error' })
        if (error) console.error(JSON.stringify({ event: 'retry_or_fail_document_job_rpc_failed', worker_id: workerId, job_id: job.id, error: error.message }))
        const row = data?.[0]
        shouldTriggerClassification = Boolean(row?.should_trigger_classification)
        if (outcome.outcome === 'retry' && row?.next_run_after) {
          retryDelayMs = Math.max(0, new Date(row.next_run_after).getTime() - Date.now())
          console.log(JSON.stringify({ event: 'worker_retry', worker_id: workerId, job_id: job.id, document_id: job.document_id, attempt: job.attempts + 1, retry_delay_ms: retryDelayMs }))
        } else if (outcome.outcome === 'failed') {
          console.log(JSON.stringify({ event: 'worker_permanently_failed', worker_id: workerId, job_id: job.id, document_id: job.document_id, attempts: job.attempts + 1, error: outcome.error }))
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

      console.log(JSON.stringify({ event: 'worker_invocation_complete', worker_id: workerId, job_id: job.id, invocation_duration_ms: Date.now() - invocationStartedAt }))
    } catch (err) {
      console.error(JSON.stringify({
        event: 'worker_invocation_uncaught_error', worker_id: workerId, job_id: job.id, document_id: job.document_id,
        invocation_duration_ms: Date.now() - invocationStartedAt,
        error: err instanceof Error ? err.message : String(err),
      }))
    }
  })())

  return new Response(JSON.stringify({ status: 'claimed', worker_id: workerId, job_id: job.id, document_id: job.document_id }), {
    status: 202,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
