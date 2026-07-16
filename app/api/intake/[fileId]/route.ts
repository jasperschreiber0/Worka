// Edge runtime — avoids Next.js's Node-runtime request handling overhead for
// a long-lived streaming response. This does NOT mean the SSE connection can
// stream indefinitely: the app is hosted on Railway (see CLAUDE.md's
// "Hosting" note), whose edge proxy still caps any HTTP/SSE connection (closed
// after 5 minutes with no data, hard capped at 15 minutes regardless — see
// https://docs.railway.com/guides/sse-vs-websockets). The self-close-and-
// reconnect logic and heartbeat further down in this file exist because of
// that platform-level ceiling, not despite it — see CONNECTION_SAFETY_MARGIN_MS.
export const runtime = 'edge'

import { NextRequest } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { shouldGiveUp, documentPhaseProgress } from '@/supabase/functions/smooth-responder/pipeline-logic'

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProgressEvent {
  stage: string
  message: string
  pct: number
}

interface CompleteEvent {
  stage: 'complete'
  message: string
  pct: 100
  quote_id: string
  assumption_count: number
  skipped_files?: string[]
  failed_files?: string[]
}

interface ClarificationQuestion {
  id: string
  question: string
  reason: string
}

interface NeedsClarificationEvent {
  stage: 'needs_clarification'
  message: string
  questions: ClarificationQuestion[]
}

// Per-document extraction status — one row per uploaded file, emitted
// while document-worker invocations are draining document_processing_jobs
// for this upload's batch (see "Document processing queue" below). Once
// every document reaches a terminal state, classification (Stage 1/2
// onward) takes over and the existing ProgressEvent/CompleteEvent stream
// resumes as before.
interface DocumentProgressItem {
  document_id: string
  filename: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  error_message?: string | null
}

interface DocumentProgressEvent {
  stage: 'document_progress'
  documents: DocumentProgressItem[]
}

// ─── Progress stages — mirrors supabase/functions/smooth-responder's real
// pipeline stages (Document Intelligence -> Project Understanding -> Scope
// Reasoning -> Gap Detection -> Estimate Generation). Demo mode below plays
// these back on a timer since there is no live reasoning engine to poll. ────

const PROGRESS_STAGES: ProgressEvent[] = [
  { stage: 'uploading',              message: 'Uploading documents...',                          pct: 5  },
  { stage: 'reading',                message: 'Reading documents...',                             pct: 12 },
  { stage: 'classifying_documents',  message: 'Classifying documents...',                          pct: 25 },
  { stage: 'understanding_project',  message: 'Building project understanding...',                 pct: 40 },
  { stage: 'reasoning_scope',        message: 'Reasoning about scope, trade by trade...',           pct: 55 },
  { stage: 'detecting_gaps',         message: 'Checking for missing information...',                pct: 65 },
  { stage: 'generating_estimate',    message: 'Generating the estimate...',                         pct: 85 },
  { stage: 'validating',             message: 'Running quality assurance...',                       pct: 92 },
  { stage: 'building_quote',         message: 'Building draft quote...',                            pct: 97 },
]

const STAGE_MESSAGE: Record<string, string> = Object.fromEntries(
  PROGRESS_STAGES.map((s) => [s.stage, s.message])
)

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function sseEvent(encoder: TextEncoder, event: string, data: object): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Job-level intake lock ──────────────────────────────────────────────────
// At most one smooth-responder run per job at a time. Acquired atomically via
// a plain INSERT into job_intake_locks (PK conflict = another run holds it) —
// see migration 030 for why: the previous "already processing" guard was
// scoped to a single file_id, so a second file uploaded to the same job while
// the first was still mid-pipeline would start a fully concurrent, unlocked
// second run. A lock older than the engine's own overall timeout is treated
// as abandoned (a run that was killed before its finally block could release
// it) and can be taken over rather than blocking the job forever.
//
// Two independent staleness checks, not one:
//   - LOCK_NO_PROGRESS_STALE_MS: the primary, much faster check. Supabase's
//     CPU-time governor kill (the actual cause of an abandoned lock in the
//     incident this was built for) is an external, uncatchable kill that can
//     happen almost immediately — well under a minute in — so a dead run's
//     lock is dead almost immediately too, not "eventually stuck." Comparing
//     against job_intake_locks.last_progress_at (migration 033, touched by
//     the engine at every real stage/batch boundary) reclaims it far sooner
//     than a fixed age check ever could. Deliberately set ABOVE the SSE
//     poller's own STUCK_TIMEOUT_MS (5 min, below) rather than close to it:
//     if a different upload session raced in and reclaimed the lock while
//     THIS run's own SSE connection hadn't yet given up watching it, two
//     concurrent runs for the same job would follow — exactly the race
//     migration 030 exists to prevent. Waiting a bit past the client's own
//     give-up point means the builder will already see "timed out" and be
//     retrying deliberately before the lock ever becomes reclaimable.
//   - LOCK_STALE_MS: an absolute backstop for the case last_progress_at
//     itself never advances for some other reason (e.g. the update call
//     silently failing) — increasing this further doesn't fix a CPU-time
//     kill, it only makes builders wait longer to recover from one; see
//     LOCK_NO_PROGRESS_STALE_MS above for the check that actually matters.
const LOCK_NO_PROGRESS_STALE_MS = 6 * 60_000
const LOCK_STALE_MS = 16 * 60_000

type LockResult = 'acquired' | 'locked'

async function tryAcquireJobLock(
  supabaseUrl: string,
  supabaseKey: string,
  anonKey: string,
  jobId: string,
  fileId: string
): Promise<LockResult> {
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
    Prefer: 'return=minimal',
  }
  const insertRes = await fetch(`${supabaseUrl}/rest/v1/job_intake_locks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ job_id: jobId, file_id: fileId }),
  })
  if (insertRes.status === 201) return 'acquired'
  if (insertRes.status !== 409) {
    // Unexpected error talking to Postgres — fail safe as "locked" rather
    // than risk triggering a second concurrent run on an ambiguous result.
    console.error('tryAcquireJobLock: unexpected status', insertRes.status, await insertRes.text().catch(() => ''))
    return 'locked'
  }

  // Someone holds it — check whether that lock is stale (the run that took
  // it was killed before releasing).
  const getRes = await fetch(
    `${supabaseUrl}/rest/v1/job_intake_locks?job_id=eq.${encodeURIComponent(jobId)}&select=started_at,last_progress_at`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${supabaseKey}`, Accept: 'application/json' } }
  )
  const rows = getRes.ok ? (await getRes.json() as Array<{ started_at: string; last_progress_at: string | null }>) : []
  const startedAt = rows[0]?.started_at ? new Date(rows[0].started_at).getTime() : 0
  const lastProgressAt = rows[0]?.last_progress_at ? new Date(rows[0].last_progress_at).getTime() : startedAt
  if (startedAt === 0) {
    return 'locked'
  }
  const staleByProgress = Date.now() - lastProgressAt > LOCK_NO_PROGRESS_STALE_MS
  const staleByAge = Date.now() - startedAt > LOCK_STALE_MS
  if (!staleByProgress && !staleByAge) {
    return 'locked'
  }

  // Stale — steal it.
  await fetch(`${supabaseUrl}/rest/v1/job_intake_locks?job_id=eq.${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: { apikey: anonKey, Authorization: `Bearer ${supabaseKey}` },
  })
  const retryRes = await fetch(`${supabaseUrl}/rest/v1/job_intake_locks`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ job_id: jobId, file_id: fileId }),
  })
  return retryRes.status === 201 ? 'acquired' : 'locked'
}

async function releaseJobLock(supabaseUrl: string, supabaseKey: string, anonKey: string, jobId: string): Promise<void> {
  await fetch(`${supabaseUrl}/rest/v1/job_intake_locks?job_id=eq.${encodeURIComponent(jobId)}`, {
    method: 'DELETE',
    headers: { apikey: anonKey, Authorization: `Bearer ${supabaseKey}` },
  }).catch(() => { /* best-effort */ })
}

// ─── Document processing queue (worker model) ──────────────────────────────
// Each uploaded document gets its own document_processing_jobs row and is
// extracted by its own document-worker Edge Function invocation — a fresh
// per-request CPU budget, per Supabase's own metering, instead of every
// document in an upload sharing one smooth-responder invocation's budget
// (see migration 034 and pipeline-logic.ts's gateTextExtraction comment for
// the incident this replaces). Returns the new batch's id, or null on any
// failure (caller treats that as a hard error, not a silent fallback to the
// old direct-invocation path — a batch that half-created would be far
// harder to reason about than a clean upfront failure).
async function createDocumentProcessingBatch(
  supabaseUrl: string,
  supabaseKey: string,
  anonKey: string,
  jobId: string,
  builderId: string,
  primaryFileId: string,
  documentIds: string[]
): Promise<string | null> {
  const headers = {
    apikey: anonKey,
    Authorization: `Bearer ${supabaseKey}`,
    'Content-Type': 'application/json',
  }

  const batchRes = await fetch(`${supabaseUrl}/rest/v1/document_processing_batches`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=representation' },
    body: JSON.stringify({ job_id: jobId, builder_id: builderId, primary_file_id: primaryFileId, status: 'running' }),
  })
  if (!batchRes.ok) {
    console.error('createDocumentProcessingBatch: batch insert failed', batchRes.status, await batchRes.text().catch(() => ''))
    return null
  }
  const batchRows = await batchRes.json() as Array<{ id: string }>
  const batchId = batchRows[0]?.id
  if (!batchId) return null

  const jobsRes = await fetch(`${supabaseUrl}/rest/v1/document_processing_jobs`, {
    method: 'POST',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify(documentIds.map((documentId) => ({ parent_job_id: batchId, document_id: documentId }))),
  })
  if (!jobsRes.ok) {
    console.error('createDocumentProcessingBatch: jobs insert failed', jobsRes.status, await jobsRes.text().catch(() => ''))
    return null
  }

  // Anchors the batch to the primary file's row so a reconnecting SSE
  // client (which already re-fetches this row every poll) can recover
  // which batch to poll without a new query-string parameter.
  await fetch(`${supabaseUrl}/rest/v1/files?id=eq.${encodeURIComponent(primaryFileId)}`, {
    method: 'PATCH',
    headers: { ...headers, Prefer: 'return=minimal' },
    body: JSON.stringify({ processing_batch_id: batchId, intake_status: 'processing' }),
  }).catch(() => { /* best-effort — the poller re-derives status from document_processing_jobs regardless */ })

  return batchId
}

interface DocumentProcessingJobRow {
  document_id: string
  status: 'pending' | 'running' | 'completed' | 'failed'
  error_message: string | null
}

async function fetchBatchJobStatuses(
  supabaseUrl: string,
  supabaseKey: string,
  anonKey: string,
  batchId: string
): Promise<DocumentProcessingJobRow[]> {
  const res = await fetch(
    `${supabaseUrl}/rest/v1/document_processing_jobs?parent_job_id=eq.${encodeURIComponent(batchId)}&select=document_id,status,error_message`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${supabaseKey}`, Accept: 'application/json' } }
  )
  if (!res.ok) return []
  return await res.json() as DocumentProcessingJobRow[]
}

// Best-effort lookup used only when giving up (timeout/failure) — the main
// polling loop already selects these columns on every iteration, but a
// give-up can happen before that iteration's fetch has run.
async function fetchSkipInfo(
  supabaseUrl: string,
  supabaseKey: string,
  anonKey: string,
  fileId: string,
  builderId: string
): Promise<{ skipped?: string[]; failed?: string[] }> {
  try {
    const res = await fetch(
      `${supabaseUrl}/rest/v1/files?id=eq.${encodeURIComponent(fileId)}&builder_id=eq.${encodeURIComponent(builderId)}&select=skipped_sibling_filenames,failed_sibling_filenames`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${supabaseKey}`, Accept: 'application/json' } }
    )
    if (!res.ok) return {}
    const rows = await res.json() as Array<{ skipped_sibling_filenames: string[] | null; failed_sibling_filenames: string[] | null }>
    const row = rows[0]
    if (!row) return {}
    return {
      skipped: row.skipped_sibling_filenames ?? undefined,
      failed: row.failed_sibling_filenames ?? undefined,
    }
  } catch {
    return {}
  }
}

// ─── GET /api/intake/[fileId] ─────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: { fileId: string } }
): Promise<Response> {
  const { fileId } = params
  const { searchParams } = new URL(req.url)
  const job_id = searchParams.get('job_id') ?? ''
  const siblingsParam = searchParams.get('siblings') ?? ''
  const sibling_file_ids = siblingsParam ? siblingsParam.split(',').filter(Boolean) : []
  // Set by IntakeProgress when reconnecting after /clarify already re-triggered
  // the engine with resume: true — skip the trigger below, poll only.
  const alreadyTriggered = searchParams.get('resumed') === '1'
  // Rides along in the URL from the client's first connection and persists
  // through the browser's automatic EventSource reconnects (same URL each
  // time) — lets this handler track overall elapsed time across the whole
  // chain of connections the hosting platform's own connection ceiling
  // forces us into (see CONNECTION_SAFETY_MARGIN_MS below for specifics),
  // not just this one connection's slice.
  const startedAtParam = Number(searchParams.get('started_at'))
  const overallStartedAt = Number.isFinite(startedAtParam) && startedAtParam > 0 ? startedAtParam : Date.now()
  // Same idea as started_at, but tracks the last time real progress (a
  // stage/pct change) was observed rather than when polling began — rides
  // along the same reconnect chain so a run that's genuinely stuck can be
  // given up on well before the 15-minute overall ceiling, while a run
  // that's slowly working through several document batches isn't punished
  // just for taking a while in total. See shouldGiveUp in pipeline-logic.ts.
  const lastProgressAtParam = Number(searchParams.get('last_progress_at'))
  let lastProgressAt = Number.isFinite(lastProgressAtParam) && lastProgressAtParam > 0 ? lastProgressAtParam : overallStartedAt

  // builder_id is always derived from the authenticated session — never from
  // the query string — so a caller can't watch or trigger another builder's
  // intake pipeline by guessing a fileId.
  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isRealMode = Boolean(supabaseUrl && supabaseKey)

  const encoder = new TextEncoder()

  // ── Demo mode ──────────────────────────────────────────────────────────────
  if (!isRealMode) {
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (const stage of PROGRESS_STAGES) {
            await delay(500)
            controller.enqueue(sseEvent(encoder, 'progress', stage))
          }

          await delay(500)

          const completeData: CompleteEvent = {
            stage: 'complete',
            message: 'Estimate ready — 3 assumptions need your review.',
            pct: 100,
            quote_id: 'demo-quote-id',
            assumption_count: 3,
          }
          controller.enqueue(sseEvent(encoder, 'complete', completeData))
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  // ── Real mode: trigger the estimating engine then poll DB ──────────────────
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

  // Verify the file actually belongs to this builder before doing anything —
  // this is the check that was previously missing entirely.
  const ownerCheckRes = await fetch(
    `${supabaseUrl}/rest/v1/files?id=eq.${encodeURIComponent(fileId)}&builder_id=eq.${encodeURIComponent(builder_id)}&select=id,intake_status`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${supabaseKey}`, Accept: 'application/json' } }
  )
  const ownerRows = ownerCheckRes.ok ? (await ownerCheckRes.json() as Array<{ id: string; intake_status: string | null }>) : []
  if (ownerRows.length === 0) {
    return new Response(JSON.stringify({ error: 'File not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  // A run is already in flight server-side once intake_status leaves its
  // pre-trigger value — this can be true even when the client's `resumed`
  // flag is false, e.g. the browser's EventSource silently reconnected
  // (network blip, an edge-runtime stream cutoff) without going through the
  // clarify flow. Trusting only the client flag here caused every reconnect
  // to fire a brand new trigger, restarting Stages 1-3 from scratch each
  // time and never reaching estimate generation.
  const alreadyProcessing = !['uploaded', null].includes(ownerRows[0].intake_status)

  // Filenames for the per-document checklist (document_progress event) —
  // fetched once per connection rather than once per 1.5s poll iteration,
  // since document_processing_jobs only carries document_id, not filename.
  const allDocumentIds = [fileId, ...sibling_file_ids]
  const filenameByDocumentId = new Map<string, string>()
  {
    const namesRes = await fetch(
      `${supabaseUrl}/rest/v1/files?id=in.(${allDocumentIds.map(encodeURIComponent).join(',')})&select=id,filename`,
      { headers: { apikey: anonKey, Authorization: `Bearer ${supabaseKey}`, Accept: 'application/json' } }
    )
    if (namesRes.ok) {
      const nameRows = await namesRes.json() as Array<{ id: string; filename: string }>
      for (const r of nameRows) filenameByDocumentId.set(r.id, r.filename)
    }
  }

  const stream = new ReadableStream({
    async start(controller) {
      const connectionStartedAt = Date.now()
      const emit = (event: string, data: object) => {
        controller.enqueue(sseEvent(encoder, event, data))
      }

      // This app runs on Railway (not Vercel — see CLAUDE.md's "Hosting"
      // note), whose edge proxy enforces its own HTTP/SSE connection ceiling:
      // a connection is closed after 5 minutes with no data sent at all, or
      // capped at 15 minutes outright even with periodic keep-alives (see
      // https://docs.railway.com/guides/sse-vs-websockets — SSE rides a
      // plain HTTP response, so it is NOT exempt from this the way a
      // WebSocket upgrade would be). This block used to be written against
      // Vercel's flat 300s-per-invocation kill (a different, now-inapplicable
      // constraint from when this app was Vercel-hosted) — the numbers below
      // happen to already satisfy Railway's real limits too (260s is under
      // both the 5-minute no-data close and the 15-minute hard cap), but the
      // REASON has changed: don't "simplify" this away just because Vercel's
      // specific 300s ceiling no longer applies — the underlying problem
      // (long-lived HTTP connections get cut by the platform) is still real,
      // just with different numbers and a different failure mode (silent
      // no-data close vs. an explicit kill). Declared ahead of the trigger
      // block below since the job-lock wait loop needs the same overall
      // give-up point the polling loop uses.
      const CONNECTION_SAFETY_MARGIN_MS = 260_000
      const OVERALL_TIMEOUT_MS = 15 * 60_000
      // Genuinely-stuck give-up point — shorter than the overall ceiling so
      // a hung run doesn't make the builder wait the full 15 minutes to
      // find out. Generous enough that a single slow Claude call on a large
      // batch (observed up to ~90s for a 60k-token call) is nowhere close.
      //
      // Set comfortably above the independent recovery service's own
      // worst-case detection+action latency (app/api/cron/intake-recovery/
      // route.ts, triggered on a schedule external to this app — see
      // .github/workflows/intake-recovery-cron.yml, or Railway's own Cron
      // Job feature if configured there instead; document_processing_jobs'
      // staleness window is 3 min — see reclaim_stale_document_jobs) rather
      // than close to it: a client that gives up right as recovery is about
      // to fix things would show the builder a false "timed out" for a run
      // that was, in fact, seconds from completing on its own. This value
      // does not gate recovery itself — it runs on its own external schedule
      // regardless of whether any client is even still connected — it only
      // controls how long a connected client waits before showing an error.
      const STUCK_TIMEOUT_MS = 9 * 60_000
      // Railway's own guidance for long SSE streams: send a heartbeat at
      // least every 5 minutes so an idle-but-healthy connection is never
      // mistaken for a dead one. Without this, the loop below only ever
      // writes to the stream when real progress happens (a stage/document
      // status change) — during a long stretch with no visible change
      // (e.g. mid-Claude-call), zero bytes would cross the wire, and only
      // the 260s reconnect margin would save it (a 40s buffer under
      // Railway's 5-minute no-data close, not zero, but tighter than this
      // deserves). A plain SSE comment line (leading colon) satisfies the
      // spec without the client's event listeners ever seeing it.
      const HEARTBEAT_INTERVAL_MS = 60_000
      let lastHeartbeatAt = Date.now()

      try {
        if (!alreadyTriggered && !alreadyProcessing) {
          // Acquire the job-level intake lock before triggering — at most one
          // smooth-responder run per job at a time (see migration 030 and
          // tryAcquireJobLock above). If another file belonging to this job
          // is still mid-pipeline, wait for it to finish rather than starting
          // a second, unlocked, concurrent run.
          let lock: LockResult = await tryAcquireJobLock(supabaseUrl!, supabaseKey!, anonKey, job_id, fileId)
          while (lock === 'locked') {
            // Plain overall ceiling here, not the stuck-check below — this
            // loop is waiting on a DIFFERENT file's run for the same job
            // (staleness of that lock is handled separately by
            // LOCK_STALE_MS), not observing this run's own progress, so
            // "no progress" isn't a meaningful signal yet.
            if (Date.now() - overallStartedAt > OVERALL_TIMEOUT_MS) {
              emit('error', { message: 'Processing timed out — please try again' })
              controller.close()
              return
            }
            emit('progress', { stage: 'queued', message: 'Finishing your last upload first...', pct: 5 })
            await delay(2000)
            lock = await tryAcquireJobLock(supabaseUrl!, supabaseKey!, anonKey, job_id, fileId)
          }

          // Real processing is about to start for this file — the stuck-
          // timeout clock (used in the polling loop below) starts fresh
          // here, not from whenever lock-wait or connection began.
          lastProgressAt = Date.now()

          // Create the batch + one document_processing_jobs row per file,
          // then kick off a small number of parallel document-worker
          // chains — each claim is atomic (FOR UPDATE SKIP LOCKED, migration
          // 034) so these can never collide on the same document. This is
          // what replaces one shared smooth-responder invocation extracting
          // every file in-process: each document now gets its own Edge
          // Function invocation and its own fresh Supabase CPU budget.
          const allDocumentIds = [fileId, ...sibling_file_ids]
          const batchId = await createDocumentProcessingBatch(
            supabaseUrl!, supabaseKey!, anonKey, job_id, builder_id, fileId, allDocumentIds
          )
          if (!batchId) {
            // The batch never started, so nothing will ever release this
            // lock via its own completion — release it here instead of
            // leaving the job locked until the staleness timeout.
            await releaseJobLock(supabaseUrl!, supabaseKey!, anonKey, job_id)
            emit('error', { message: 'Failed to start processing' })
            controller.close()
            return
          }

          // 4 parallel chains, capped at the document count. Was 2 — fine
          // for small residential uploads, but a 20-30 document commercial
          // set meant each chain serially processing 10-15 documents, and a
          // single chain death (CPU-kill on one pathological PDF) orphaned
          // half the batch until recovery's next cycle. More chains =
          // faster drain AND smaller blast radius per chain death. Claims
          // are FOR UPDATE SKIP LOCKED (migration 034), so concurrency here
          // can never double-process a document, and each invocation gets
          // its own CPU budget regardless of how many run at once.
          const WORKER_CONCURRENCY = Math.min(4, allDocumentIds.length)
          await Promise.all(
            Array.from({ length: WORKER_CONCURRENCY }, () =>
              fetch(`${supabaseUrl}/functions/v1/document-worker`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
                body: JSON.stringify({ parent_job_id: batchId, builder_id }),
              }).catch((err) => console.error('document-worker trigger failed', err))
            )
          )
        }

        // Emit initial stage immediately
        emit('progress', PROGRESS_STAGES[0])

        // Starts as 'uploading' (not '') because the line above already
        // emitted that stage — starting empty would make the stage-diff
        // block below re-emit "uploading, 5%" on the first poll iteration,
        // AFTER the synthetic document-phase 'reading' progress emitted
        // earlier in the same iteration, walking the UI backwards.
        let lastStage = 'uploading'
        // Tracked separately from lastStage: multiple document batches all
        // report the same 'classifying_documents' stage key, so batch-to-
        // batch progress needs its own signal for the stuck-timeout check
        // below — otherwise a slow-but-genuinely-progressing multi-batch
        // run could look identical to a truly hung one.
        let lastBatchIndex: number | null = null
        // Per-document extraction checklist snapshot — only re-emitted when
        // it actually changes, so a steady stream of identical polls
        // doesn't spam the client with duplicate document_progress events.
        let lastDocumentProgressSnapshot = ''
        // Synthetic document-phase progress message — see documentPhaseProgress
        // in pipeline-logic.ts. Tracked separately from lastStage because this
        // whole phase happens BEFORE classification ever writes
        // files.intake_stage, so the stage-diff logic below never fires
        // during it.
        let lastDocumentPhaseMessage = ''

        // Poll the files table until extraction completes, pauses for
        // clarification, or fails.
        //
        // The reasoning-first engine's three large sequential Claude calls
        // can genuinely exceed the hosting platform's connection ceiling on
        // a real project, so instead of waiting to be killed, this
        // connection self-closes cleanly at a safe margin under that limit
        // and tells the client to open a fresh connection (see the
        // 'reconnect' emit below) rather than treating the close as a
        // failure. The retrigger-prevention check above means that reconnect
        // only polls, never restarts the pipeline, so the underlying
        // Supabase-side run (independent of this HTTP connection) keeps
        // going undisturbed across as many reconnect cycles as it needs.
        // OVERALL_TIMEOUT_MS is the real give-up point, tracked across that
        // whole chain via overallStartedAt, not just this connection's slice.
        for (let attempts = 0; ; attempts++) {
          if (shouldGiveUp(Date.now(), overallStartedAt, lastProgressAt, OVERALL_TIMEOUT_MS, STUCK_TIMEOUT_MS)) {
            // Skip/fail info was previously only ever attached to the
            // 'complete' event — a timeout gave the builder zero indication
            // anything had even been attempted, let alone what was skipped.
            // smooth-responder now writes these columns as soon as batching
            // decides them (not just on eventual success), so they're
            // available here even when the run never finished.
            const { skipped, failed } = await fetchSkipInfo(supabaseUrl!, supabaseKey!, anonKey, fileId, builder_id)
            emit('error', { message: 'Processing timed out — please try again', skipped_files: skipped, failed_files: failed })
            controller.close()
            return
          }
          if (Date.now() - connectionStartedAt > CONNECTION_SAFETY_MARGIN_MS) {
            // Deliberate close well before the platform's own connection
            // ceiling (see CONNECTION_SAFETY_MARGIN_MS's declaration above).
            // A plain close still fires EventSource's native 'error' (it
            // can't tell a deliberate close from a real connection loss), so
            // emit an explicit 'reconnect' event first — IntakeProgress
            // listens for it and opens a fresh connection itself instead of
            // treating this as a failure.
            emit('reconnect', {})
            controller.close()
            return
          }
          if (Date.now() - lastHeartbeatAt > HEARTBEAT_INTERVAL_MS) {
            // Plain SSE comment (leading colon) — valid per spec, silently
            // ignored by EventSource's event listeners, exists purely to put
            // bytes on the wire so an idle-but-healthy connection doesn't
            // look identical to a dead one to Railway's no-data-close timer.
            controller.enqueue(encoder.encode(': heartbeat\n\n'))
            lastHeartbeatAt = Date.now()
          }
          await delay(1500)

          const res = await fetch(
            `${supabaseUrl}/rest/v1/files?id=eq.${encodeURIComponent(fileId)}&builder_id=eq.${encodeURIComponent(builder_id)}&select=intake_status,intake_stage,intake_pct,quote_id,intake_assumption_count,failure_stage,failure_reason,skipped_sibling_filenames,failed_sibling_filenames,processing_batch_id`,
            {
              headers: {
                'apikey': anonKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Accept': 'application/json',
              },
            }
          )

          if (!res.ok) continue

          const rows = await res.json() as Array<{
            intake_status: string
            intake_stage: string | null
            intake_pct: number | null
            quote_id: string | null
            intake_assumption_count: number | null
            failure_stage: string | null
            failure_reason: string | null
            skipped_sibling_filenames: string[] | null
            failed_sibling_filenames: string[] | null
            intake_batch_index: number | null
            intake_batch_count: number | null
            processing_batch_id: string | null
          }>
          const row = rows[0]
          if (!row) continue

          // Per-document extraction checklist — while document-worker
          // invocations are still draining document_processing_jobs for
          // this batch, surface each document's own status instead of
          // making the builder wait for a single aggregate progress bar.
          // Once classification takes over, these rows are all terminal
          // (completed/failed) and simply stop changing, so this becomes a
          // no-op for the rest of the run.
          if (row.processing_batch_id) {
            const jobRows = await fetchBatchJobStatuses(supabaseUrl!, supabaseKey!, anonKey, row.processing_batch_id)
            if (jobRows.length > 0) {
              const snapshot = JSON.stringify(jobRows)
              if (snapshot !== lastDocumentProgressSnapshot) {
                lastDocumentProgressSnapshot = snapshot
                const documents: DocumentProgressItem[] = jobRows.map((j) => ({
                  document_id: j.document_id,
                  filename: filenameByDocumentId.get(j.document_id) ?? j.document_id,
                  status: j.status,
                  error_message: j.error_message,
                }))
                const documentProgress: DocumentProgressEvent = { stage: 'document_progress', documents }
                emit('document_progress', documentProgress)
                lastProgressAt = Date.now()
              }

              // Honest overall progress during the document-extraction phase.
              // Classification hasn't started yet (it's what writes
              // intake_stage/intake_pct), so without this the progress bar
              // sits frozen at "Uploading documents... 5%" for the entire
              // extraction phase — indistinguishable, to the builder, from a
              // genuinely hung run. Derived from the same job rows fetched
              // above; hands off cleanly to classification's first real
              // write (classifying_documents, 25%) since this caps at 20%.
              // Gated on the stage still being pre-classification so a
              // reconnect mid-classification can't emit a backwards jump.
              if (!row.intake_stage || row.intake_stage === 'uploading' || row.intake_stage === 'reading') {
                const terminalCount = jobRows.filter((j) => j.status === 'completed' || j.status === 'failed').length
                const { pct, message } = documentPhaseProgress(terminalCount, jobRows.length)
                if (message !== lastDocumentPhaseMessage) {
                  lastDocumentPhaseMessage = message
                  emit('progress', { stage: 'reading', message, pct })
                  lastProgressAt = Date.now()
                }
              }
            }
          }

          const stage = row.intake_stage ?? 'uploading'
          const pct = row.intake_pct ?? 5

          if (stage !== lastStage && !['complete', 'failed', 'awaiting_clarification'].includes(stage)) {
            let message = STAGE_MESSAGE[stage] ?? stage
            // Real per-batch progress, not cosmetic — smooth-responder writes
            // these two columns at each batch boundary when a run spans more
            // than one Stage 1/2 Claude call (see MAX_BATCHES there).
            if (stage === 'classifying_documents' && row.intake_batch_count && row.intake_batch_count > 1 && row.intake_batch_index) {
              message = `${message} — batch ${row.intake_batch_index} of ${row.intake_batch_count}`
            }
            emit('progress', { stage, message, pct })
            lastStage = stage
            lastProgressAt = Date.now()
          }
          if (row.intake_batch_index != null && row.intake_batch_index !== lastBatchIndex) {
            lastBatchIndex = row.intake_batch_index
            lastProgressAt = Date.now()
          }

          // Stage 4/5: the engine found a blocking gap and stopped before
          // generating an estimate — surface the questions and end the stream.
          if (row.intake_status === 'needs_info') {
            const qRes = await fetch(
              `${supabaseUrl}/rest/v1/clarifying_questions?job_id=eq.${encodeURIComponent(job_id)}&status=eq.open&blocking=eq.true&select=id,question,reason`,
              {
                headers: {
                  'apikey': anonKey,
                  'Authorization': `Bearer ${supabaseKey}`,
                  'Accept': 'application/json',
                },
              }
            )
            const questions = qRes.ok ? await qRes.json() as ClarificationQuestion[] : []
            const needsClarification: NeedsClarificationEvent = {
              stage: 'needs_clarification',
              message: 'A few things would materially change this estimate — answer these before WorkA prices the job.',
              questions,
            }
            emit('needs_clarification', needsClarification)
            controller.close()
            return
          }

          if (row.intake_status === 'extracted' && row.quote_id) {
            // The reasoning engine only produces quantities — resolve rates
            // through the 5-tier hierarchy, then run the Stage 8 QA pass.
            // Idempotent, best-effort: neither failure blocks intake.
            try {
              const { createClient } = await import('@supabase/supabase-js')
              const { ensureQuotePriced } = await import('@/lib/pricing')
              const { runQualityAssurance } = await import('@/lib/estimating/qa')
              const supabase = createClient(supabaseUrl!, supabaseKey!)
              await ensureQuotePriced(supabase, row.quote_id)
              await runQualityAssurance(supabase, row.quote_id, job_id)
            } catch (pricingErr) {
              console.error('Intake pricing/QA error:', pricingErr)
            }

            // Persist a project-understanding snapshot (confidence, open
            // question count) onto the job row right when intake completes
            // — not just ephemerally inside a chat answer — so Job
            // Snapshot/Morning Brief can eventually surface it without
            // requiring a builder to ask a chat question first. Same
            // computation path chat's project_question intent uses (see
            // lib/project-context.ts); idempotent, best-effort.
            try {
              const { createClient } = await import('@supabase/supabase-js')
              const { persistProjectUnderstanding } = await import('@/lib/project-context')
              const supabase = createClient(supabaseUrl!, supabaseKey!)
              await persistProjectUnderstanding(supabase, job_id)
            } catch (understandingErr) {
              console.error('Intake project-understanding persist error:', understandingErr)
            }

            const count = row.intake_assumption_count ?? 0
            const completeData: CompleteEvent = {
              stage: 'complete',
              message: `Estimate ready — ${count} assumption${count !== 1 ? 's' : ''} need your review.`,
              pct: 100,
              quote_id: row.quote_id,
              assumption_count: count,
              skipped_files: row.skipped_sibling_filenames ?? undefined,
              failed_files: row.failed_sibling_filenames ?? undefined,
            }
            emit('complete', completeData)
            controller.close()
            return
          }

          if (row.intake_status === 'failed') {
            console.error('Intake failed:', fileId, row.failure_stage, row.failure_reason)
            emit('error', {
              message: 'Processing failed — please try again',
              skipped_files: row.skipped_sibling_filenames ?? undefined,
              failed_files: row.failed_sibling_filenames ?? undefined,
            })
            controller.close()
            return
          }
        }
        // Unreachable: the loop above only exits via an explicit return
        // (complete / needs_clarification / failed / overall timeout / safe
        // self-close for reconnect).
      } catch (err) {
        console.error('Intake poll error:', err)
        emit('error', { message: 'Processing failed — please try again' })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
