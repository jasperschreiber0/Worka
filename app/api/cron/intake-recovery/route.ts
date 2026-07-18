import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─── GET /api/cron/intake-recovery ───────────────────────────────────────────
//
// The independent recovery service for the document-intake / estimating
// pipeline (see supabase/migrations/037_intake_recovery_service.sql for the
// SQL primitives this calls). Root cause it exists to close: every previous
// recovery mechanism in this pipeline (reclaim_stale_document_jobs,
// job_intake_locks staleness) was only ever INVOKED by the same chain of
// triggers that can fail in the first place —
//   - reclaim_stale_document_jobs only runs inside claim_next_document_job,
//     which only runs inside a live document-worker invocation. A crashed
//     single-document upload's one worker has no sibling invocation left to
//     ever call it again — the row (and the whole batch, and the builder's
//     estimate) is stuck forever with nothing to notice.
//   - job_intake_locks' staleness check only runs when a NEW upload arrives
//     for the same job. A builder who just waits never gets a second
//     trigger, so a dead smooth-responder run's file sits at
//     intake_status='processing' forever.
//   - triggerNext/triggerClassification (document-worker/index.ts) are
//     fire-and-forget fetches with a swallowed catch — a lost network call
//     has no retry at all.
//
// This route depends on NONE of that. It runs on a fixed schedule (see
// vercel.json), reads the current DB state cold, and independently decides
// what to reclaim/resume — even if every single worker/pipeline invocation
// for a given job died, this route notices and fixes it on its own, with no
// user reconnect, no new upload, and no other worker required. That is what
// makes recovery here "independent of the crashed worker."
//
// Idempotent + safe under concurrent builders: every SQL primitive it calls
// is either a plain read, an atomic conditional UPDATE (claim_next_document_job
// row-locks via FOR UPDATE SKIP LOCKED — see migration 034/036/037), or an
// atomic acquire-or-reclaim (acquire_or_reclaim_job_intake_lock re-verifies
// staleness under FOR UPDATE at the moment it acts, not just at the earlier
// read that found the candidate) — running this route twice concurrently, or
// once every few minutes forever, never double-processes the same row or
// duplicates work. Nothing here is scoped to one builder; a single run sweeps
// every builder's stuck rows in one pass.
//
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` automatically
// when the CRON_SECRET env var is set on the project — same fail-closed
// pattern as the other two cron routes.

export const dynamic = 'force-dynamic'

// Bounds on how many candidates this one run will act on, independent of how
// many the read-only finder functions return. This is deliberate backpressure:
// if something is systemically broken (e.g. Anthropic is down and every batch
// is failing/stalling), a single cron run should not fire an unbounded storm
// of re-triggers — it makes visible, bounded progress each run and logs
// clearly when it hit the cap, and the next scheduled run picks up the rest.
const MAX_BATCHES_PER_RUN = 20
const MAX_LOCKS_PER_RUN = 10
const MAX_STUCK_FILES_PER_RUN = 10

// Hard ceiling on how many times this cron will reclaim a stale
// job_intake_lock or retry classification for the SAME file. Without this,
// a file whose processing fails deterministically every time (e.g. an
// Anthropic credit outage) never releases its lock cleanly, the lock goes
// stale, this cron reclaims it, the same expensive Stage 1/2 AI call fires
// again, fails again, and repeats forever — an uncontrolled spend loop, not
// a recovery mechanism. Matches document_processing_jobs' own retry cap
// (retry_or_fail_document_job, migration 034).
const MAX_RECOVERY_ATTEMPTS = 3

interface RunSummary {
  document_jobs_reclaimed: number
  stalled_batches_recomputed: number
  batches_resumed: number
  stale_locks_released: number
  abandoned_files_marked_failed: number
  job_locks_reclaimed: number
  stuck_files_retried: number
  files_permanently_failed: number
  errors: Array<{ stage: string; message: string }>
}

function log(event: string, fields: Record<string, unknown> = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

// ── TWO INDEPENDENT KILL SWITCHES ────────────────────────────────────────
// Split, deliberately, along the one boundary that matters for spend
// safety: whether a step can ever call Anthropic.
//
//   DOCUMENT_RECOVERY_DISABLED gates steps 1-3 (reclaim_stale_document_
//   jobs, recompute_stalled_batches, find_batches_with_claimable_work).
//   None of these call Anthropic — they only reclaim/resume
//   document-worker's own text-extraction queue. This is what actually
//   unsticks a batch stuck in "Reading documents..." (a crashed extraction
//   worker, or a lost triggerNext/triggerClassification fetch downstream
//   of it never being resumed) — the everyday, harmless failure mode.
//
//   AI_RECOVERY_DISABLED gates steps 4-5 (find_stale_job_intake_locks +
//   acquire_or_reclaim_job_intake_lock, find_stuck_files_needing_
//   classification_retry) — both ultimately fire smooth-responder, which
//   calls Anthropic. This is the axis the production incident lived on
//   (a batch that timed out deterministically getting re-triggered here
//   forever) and the axis the classification/retry-cap redesign (see
//   CLAUDE.md "Anthropic failure classification and retry redesign") and
//   its three follow-up correctness fixes (solo-retry reachability,
//   chunked-file dedup, atomic counter) were built to close. Kept
//   disabled here until that redesign has been observed under a real,
//   manually-watched production run — see the "run one complete 7-document
//   estimate with AI recovery disabled" verification step.
//
// Before this split, ONE flag gated both — meaning the emergency stop for
// the AI-spend bug also silently disabled the everyday, zero-cost
// document-extraction recovery, leaving ordinary stuck uploads with no
// automatic fix either. That coupling is exactly what this split removes.
const DOCUMENT_RECOVERY_DISABLED = false
const AI_RECOVERY_DISABLED = true

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  const isRealMode = Boolean(supabaseUrl && supabaseKey)

  // ── Auth guard — fail closed in real mode, exactly like the other crons ──
  // Runs unconditionally, before either kill switch is consulted — a prior
  // version of this route short-circuited on RECOVERY_DISABLED before this
  // check, so an unauthenticated request got a 200 instead of a 401 while
  // recovery was off. Neither kill switch should ever change the auth
  // contract of this endpoint.
  const cronSecret = process.env.CRON_SECRET
  if (isRealMode && !cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!supabaseUrl || !supabaseKey || !anonKey) {
    return NextResponse.json({ ran: false, skipped: 'demo mode — no Supabase configured' })
  }

  const runStartedAt = Date.now()
  const runStartedAtIso = new Date(runStartedAt).toISOString()
  const summary: RunSummary = {
    document_jobs_reclaimed: 0,
    stalled_batches_recomputed: 0,
    batches_resumed: 0,
    stale_locks_released: 0,
    abandoned_files_marked_failed: 0,
    job_locks_reclaimed: 0,
    stuck_files_retried: 0,
    files_permanently_failed: 0,
    errors: [],
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  if (DOCUMENT_RECOVERY_DISABLED) {
    log('recovery_document_steps_skipped', { reason: 'DOCUMENT_RECOVERY_DISABLED' })
  } else {
    // ── 1. Reclaim document_processing_jobs rows stuck at 'running' ─────────
    // Sweeps every batch (no parent_job_id filter) — a worker crash mid-
    // extraction leaves locked_at frozen; anything past the 3-minute
    // staleness window is requeued (or permanently failed, past 3 attempts)
    // by the exact same logic a genuine catchable failure gets.
    try {
      const { data, error } = await supabase.rpc('reclaim_stale_document_jobs')
      if (error) throw error
      summary.document_jobs_reclaimed = data?.length ?? 0
      if (summary.document_jobs_reclaimed > 0) {
        log('recovery_document_jobs_reclaimed', { count: summary.document_jobs_reclaimed, jobs: data })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      summary.errors.push({ stage: 'reclaim_stale_document_jobs', message })
      log('recovery_stage_failed', { stage: 'reclaim_stale_document_jobs', error: message })
    }

    // ── 2. Defense-in-depth: recompute any batch stuck 'running'/'pending'
    //      with no non-terminal children (should be a no-op in steady state).
    try {
      const { data, error } = await supabase.rpc('recompute_stalled_batches')
      if (error) throw error
      summary.stalled_batches_recomputed = data?.length ?? 0
      if (summary.stalled_batches_recomputed > 0) {
        log('recovery_stalled_batches_recomputed', { count: summary.stalled_batches_recomputed, batches: data })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      summary.errors.push({ stage: 'recompute_stalled_batches', message })
      log('recovery_stage_failed', { stage: 'recompute_stalled_batches', error: message })
    }

    // ── 3. Resume batches whose worker chain has stopped self-sustaining ────
    // reclaim above may have just requeued rows; equally, a batch's ONE
    // worker (single-document upload) may have died before ever calling
    // claim_next_document_job a second time, so nothing has swept it yet
    // either — find_batches_with_claimable_work catches both. Firing one
    // fresh document-worker invocation per batch is enough: triggerNext
    // (document-worker/index.ts) keeps the chain going from there. Never
    // calls smooth-responder — no Anthropic exposure.
    try {
      const { data, error } = await supabase.rpc('find_batches_with_claimable_work')
      if (error) throw error
      const batches = (data ?? []) as Array<{ parent_job_id: string; job_id: string; builder_id: string; pending_count: number }>
      const toResume = batches.slice(0, MAX_BATCHES_PER_RUN)
      if (batches.length > MAX_BATCHES_PER_RUN) {
        log('recovery_batch_cap_hit', { candidates: batches.length, capped_to: MAX_BATCHES_PER_RUN })
      }
      const results = await Promise.allSettled(
        toResume.map((b) =>
          fetch(`${supabaseUrl}/functions/v1/document-worker`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
            body: JSON.stringify({ parent_job_id: b.parent_job_id, builder_id: b.builder_id }),
          })
        )
      )
      summary.batches_resumed = results.filter((r) => r.status === 'fulfilled' && (r.value as Response).ok).length
      if (toResume.length > 0) {
        log('recovery_batches_resumed', {
          attempted: toResume.length, succeeded: summary.batches_resumed,
          parent_job_ids: toResume.map((b) => b.parent_job_id),
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      summary.errors.push({ stage: 'find_batches_with_claimable_work', message })
      log('recovery_stage_failed', { stage: 'find_batches_with_claimable_work', error: message })
    }

    // ── 3b. Release stale job_intake_locks (SAFE — deletes only, never
    //      re-acquires and never triggers smooth-responder) ─────────────────
    // Root cause of the intake-pipeline freeze this closes: the lock is
    // created by the upload route (app/api/intake/[fileId]/route.ts,
    // tryAcquireJobLock) BEFORE the processing chain starts, but is only
    // ever DELETED from inside smooth-responder's own try/finally. If the
    // handoff into smooth-responder is lost (the exact failure this session
    // diagnosed — extraction finishes, but triggerClassification's
    // fire-and-forget fetch never lands), smooth-responder never starts, so
    // nothing ever reaches the code that releases the lock — it sits open
    // forever. No worker is running, no progress is happening, and no
    // user-visible failure exists: the job just looks permanently frozen.
    // tryAcquireJobLock already has its OWN inline steal-if-stale check, but
    // that only runs when a NEW upload happens to arrive for the same job —
    // a builder who doesn't retry gets no second chance at it. This step is
    // the independent, scheduled equivalent: it runs on this cron's own
    // fixed cadence regardless of whether anyone uploads again.
    //
    // Deliberately just a DELETE, not acquire_or_reclaim_job_intake_lock
    // (used by the AI-gated step below) — that RPC also INSERTS a new lock
    // for the caller to immediately act on, which is correct when the
    // caller is about to trigger smooth-responder itself, but wrong here:
    // this step has no new run to hand the lock to, so inserting one would
    // just create a second, differently-shaped stuck lock. A plain delete
    // leaves the job unlocked so the next legitimate trigger (a fresh
    // upload, or — once AI recovery is re-enabled — step 5 below, whose own
    // find_stuck_files_needing_classification_retry query explicitly
    // requires NO job_intake_locks row to match) can proceed cleanly.
    // find_stale_job_intake_locks is a plain read (migration 037) — same
    // staleness definition (6min no-progress / 16min absolute) already used
    // by tryAcquireJobLock's own inline check, so a lock is only ever
    // considered reclaimable once a run would already be considered dead by
    // every other part of this codebase. There is no separate "is a worker
    // still physically running" check anywhere in this system (smooth-
    // responder is an ephemeral Edge Function invocation with no PID to
    // query) — that staleness window IS the proxy for it, consistent with
    // how job_intake_locks staleness has always been defined here. Never
    // calls Anthropic, never fetches smooth-responder or document-worker.
    try {
      const { data, error } = await supabase.rpc('find_stale_job_intake_locks')
      if (error) throw error
      const staleLocks = (data ?? []) as Array<{ job_id: string; file_id: string; started_at: string; last_progress_at: string; stale_for: string }>
      for (const lock of staleLocks) {
        // release_stale_job_intake_lock re-verifies staleness atomically
        // (FOR UPDATE) at the moment it deletes — this read above can be
        // momentarily stale by the time we act on it (a genuinely new run
        // could have reclaimed this exact job_id in between); the RPC is
        // what actually decides whether to delete, not this loop.
        const { data: releaseData, error: releaseErr } = await supabase.rpc('release_stale_job_intake_lock', {
          p_job_id: lock.job_id,
        })
        if (releaseErr) {
          summary.errors.push({ stage: `release_stale_lock:${lock.job_id}`, message: releaseErr.message })
          log('recovery_stage_failed', { stage: 'release_stale_lock', job_id: lock.job_id, error: releaseErr.message })
          continue
        }
        const result = releaseData?.[0]
        if (!result?.released) continue // already gone, or made real progress since the read above — correctly left alone

        summary.stale_locks_released++
        log('stale_lock_reclaimed', {
          job_id: lock.job_id,
          file_id: result.file_id,
          started_at: result.started_at,
          last_progress_at: result.last_progress_at,
          previous_lock_age: result.stale_for,
          reason: 'stale_lock_reclaimed',
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      summary.errors.push({ stage: 'find_stale_job_intake_locks_safe', message })
      log('recovery_stage_failed', { stage: 'find_stale_job_intake_locks_safe', error: message })
    }

    // ── 3c. Mark genuinely abandoned files failed (SAFE — files bookkeeping
    //      only, never calls Anthropic or triggers any worker) ─────────────
    // Migration 045 (just above) stops a stuck lock from blocking the JOB
    // forever, but does nothing for the FILE's own intake_status — a file
    // left at 'uploaded'/'queued'/'processing' with its lock now cleared
    // (or one that never had a lock at all, e.g. the SSE trigger was never
    // opened) just sits there indefinitely with no visible failure. Across
    // repeated retries on the same job this accumulates silently — the
    // direct cause of a job showing "173 plans uploaded but not yet
    // processed" for what was really 7 documents retried many times over
    // one day. find_and_fail_abandoned_files (migration 046) only touches
    // files whose job currently holds NO job_intake_locks row at all (an
    // active or even a still-stale-but-not-yet-reclaimed run is left
    // strictly alone) and that have been non-terminal for well over any
    // legitimate run's own timeout (2h, vs. the SSE poller's 15min
    // OVERALL_TIMEOUT_MS) — see the migration's own comment for why this
    // can never touch a run a connected client would still consider live.
    try {
      const { data, error } = await supabase.rpc('find_and_fail_abandoned_files')
      if (error) throw error
      const abandoned = (data ?? []) as Array<{ file_id: string; job_id: string; filename: string; previous_status: string; age: string }>
      summary.abandoned_files_marked_failed = abandoned.length
      for (const f of abandoned) {
        log('abandoned_file_marked_failed', {
          job_id: f.job_id, file_id: f.file_id, filename: f.filename,
          previous_status: f.previous_status, age: f.age, reason: 'abandoned_file_marked_failed',
        })
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      summary.errors.push({ stage: 'find_and_fail_abandoned_files', message })
      log('recovery_stage_failed', { stage: 'find_and_fail_abandoned_files', error: message })
    }
  }

  if (AI_RECOVERY_DISABLED) {
    log('recovery_ai_steps_skipped', { reason: 'AI_RECOVERY_DISABLED' })
  } else {
      // ── 4. Reclaim stale job_intake_locks and resume the pipeline itself ────
      // A dead smooth-responder run (its own EdgeRuntime.waitUntil killed
      // externally) leaves job_intake_locks held with a frozen last_progress_at
      // and the file stuck at intake_status='processing' — indefinitely, since
      // the only prior recovery for this (tryAcquireJobLock) only fires when a
      // NEW upload arrives for the same job. acquire_or_reclaim_job_intake_lock
      // re-verifies staleness atomically at the moment of reclaim (not just at
      // this read), so a lock that made real progress between the read below
      // and the RPC call is correctly left alone.
      try {
        const { data, error } = await supabase.rpc('find_stale_job_intake_locks')
        if (error) throw error
        const candidates = (data ?? []) as Array<{ job_id: string; file_id: string }>
        const toReclaim = candidates.slice(0, MAX_LOCKS_PER_RUN)
        if (candidates.length > MAX_LOCKS_PER_RUN) {
          log('recovery_lock_cap_hit', { candidates: candidates.length, capped_to: MAX_LOCKS_PER_RUN })
        }

        for (const candidate of toReclaim) {
          try {
            const { data: reclaimData, error: reclaimErr } = await supabase.rpc('acquire_or_reclaim_job_intake_lock', {
              p_job_id: candidate.job_id,
              p_file_id: candidate.file_id,
            })
            if (reclaimErr) throw reclaimErr
            const reclaimed = reclaimData?.[0]
            if (!reclaimed?.acquired) {
              // Raced with the run making progress, or another recovery pass —
              // correctly left alone.
              continue
            }

            // Already terminal? Nothing to resume — the lock was just leaked
            // past the pipeline's own release (shouldn't happen given its
            // try/finally, but a stuck lock alone is harmless to release).
            const { data: fileRow } = await supabase
              .from('files')
              .select('id, intake_status, builder_id, processing_batch_id, intake_recovery_attempts')
              .eq('id', candidate.file_id)
              .single()
            if (!fileRow || ['extracted', 'failed', 'needs_info'].includes(fileRow.intake_status)) {
              await supabase.from('job_intake_locks').delete().eq('job_id', candidate.job_id)
              continue
            }

            // Retry cap: a lock that keeps going stale means the pipeline run
            // it's protecting keeps dying (or failing) every single time — most
            // often a transient outage (e.g. Anthropic credits) that recovery
            // cannot fix by re-running the same expensive AI call again. Stop
            // after MAX_RECOVERY_ATTEMPTS rather than retrying forever.
            if (fileRow.intake_recovery_attempts >= MAX_RECOVERY_ATTEMPTS) {
              await supabase
                .from('files')
                .update({
                  intake_status: 'failed',
                  failure_reason: `Automatic recovery retry cap (${MAX_RECOVERY_ATTEMPTS}) reached while reclaiming a stale processing lock — processing failed to complete repeatedly and was stopped to prevent runaway retries. Manual re-upload required.`,
                })
                .eq('id', candidate.file_id)
              await supabase.from('job_intake_locks').delete().eq('job_id', candidate.job_id)
              summary.files_permanently_failed++
              log('recovery_retry_cap_reached', {
                stage: 'stale_lock_reclaim', job_id: candidate.job_id, file_id: candidate.file_id,
                attempts: fileRow.intake_recovery_attempts,
              })
              continue
            }
            await supabase
              .from('files')
              .update({ intake_recovery_attempts: fileRow.intake_recovery_attempts + 1 })
              .eq('id', candidate.file_id)

            summary.job_locks_reclaimed++
            log('recovery_job_lock_reclaimed', { job_id: candidate.job_id, file_id: candidate.file_id, processing_batch_id: fileRow.processing_batch_id, recovery_attempts: fileRow.intake_recovery_attempts + 1 })

            // Prefer the queue-model resume path (re-reads each document's
            // already-persisted extraction result — no re-download/re-parse of
            // the CPU-bound step) when this file went through document-worker;
            // fall back to the legacy direct-invocation shape otherwise.
            const triggerBody = fileRow.processing_batch_id
              ? { parent_job_id: fileRow.processing_batch_id }
              : { file_id: fileRow.id, job_id: candidate.job_id, builder_id: fileRow.builder_id, resume: false }

            await fetch(`${supabaseUrl}/functions/v1/smooth-responder`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
              body: JSON.stringify(triggerBody),
            }).catch((fetchErr) => {
              log('recovery_smooth_responder_trigger_failed', { job_id: candidate.job_id, error: String(fetchErr) })
            })
          } catch (innerErr) {
            const message = innerErr instanceof Error ? innerErr.message : String(innerErr)
            summary.errors.push({ stage: `reclaim_job_lock:${candidate.job_id}`, message })
            log('recovery_stage_failed', { stage: 'reclaim_job_lock', job_id: candidate.job_id, error: message })
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        summary.errors.push({ stage: 'find_stale_job_intake_locks', message })
        log('recovery_stage_failed', { stage: 'find_stale_job_intake_locks', error: message })
      }

      // ── 5. Retry classification for batches that finished but never actually
      //      reached smooth-responder (triggerClassification's fetch was lost).
      try {
        const { data, error } = await supabase.rpc('find_stuck_files_needing_classification_retry')
        if (error) throw error
        const stuckFiles = (data ?? []) as Array<{ file_id: string; job_id: string; builder_id: string; processing_batch_id: string }>
        const toRetry = stuckFiles.slice(0, MAX_STUCK_FILES_PER_RUN)
        if (stuckFiles.length > MAX_STUCK_FILES_PER_RUN) {
          log('recovery_stuck_files_cap_hit', { candidates: stuckFiles.length, capped_to: MAX_STUCK_FILES_PER_RUN })
        }

        for (const f of toRetry) {
          // acquire_or_reclaim_job_intake_lock also guards this path — if a
          // fresh upload or a step 4 reclaim just started a run for this same
          // job, this simply fails to acquire and is skipped, never double-fires.
          const { data: lockData, error: lockErr } = await supabase.rpc('acquire_or_reclaim_job_intake_lock', {
            p_job_id: f.job_id,
            p_file_id: f.file_id,
          })
          if (lockErr || !lockData?.[0]?.acquired) continue

          const { data: stuckFileRow } = await supabase
            .from('files')
            .select('intake_recovery_attempts')
            .eq('id', f.file_id)
            .single()
          const attempts = stuckFileRow?.intake_recovery_attempts ?? 0

          // Same retry cap as step 4 — a file that keeps needing a
          // classification retry is failing every time it's re-triggered, not
          // recovering from a one-off lost network call.
          if (attempts >= MAX_RECOVERY_ATTEMPTS) {
            await supabase
              .from('files')
              .update({
                intake_status: 'failed',
                failure_reason: `Automatic recovery retry cap (${MAX_RECOVERY_ATTEMPTS}) reached while retrying classification — processing failed to complete repeatedly and was stopped to prevent runaway retries. Manual re-upload required.`,
              })
              .eq('id', f.file_id)
            await supabase.from('job_intake_locks').delete().eq('job_id', f.job_id)
            summary.files_permanently_failed++
            log('recovery_retry_cap_reached', {
              stage: 'stuck_classification_retry', job_id: f.job_id, file_id: f.file_id, attempts,
            })
            continue
          }
          await supabase
            .from('files')
            .update({ intake_recovery_attempts: attempts + 1 })
            .eq('id', f.file_id)

          summary.stuck_files_retried++
          log('recovery_classification_retriggered', { job_id: f.job_id, file_id: f.file_id, processing_batch_id: f.processing_batch_id, recovery_attempts: attempts + 1 })
          await fetch(`${supabaseUrl}/functions/v1/smooth-responder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
            body: JSON.stringify({ parent_job_id: f.processing_batch_id }),
          }).catch((fetchErr) => {
            log('recovery_smooth_responder_trigger_failed', { job_id: f.job_id, error: String(fetchErr) })
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        summary.errors.push({ stage: 'find_stuck_files_needing_classification_retry', message })
        log('recovery_stage_failed', { stage: 'find_stuck_files_needing_classification_retry', error: message })
      }
  }

  const durationMs = Date.now() - runStartedAt

  // Persistent audit row (migration 037) — survives past ephemeral function
  // log retention, and is queryable with SQL when diagnosing a later
  // incident ("was recovery even running that day? did it see this job?").
  await supabase.from('intake_recovery_runs').insert({
    run_started_at: runStartedAtIso,
    run_finished_at: new Date().toISOString(),
    duration_ms: durationMs,
    document_jobs_reclaimed: summary.document_jobs_reclaimed,
    stalled_batches_recomputed: summary.stalled_batches_recomputed,
    batches_resumed: summary.batches_resumed,
    stale_locks_released: summary.stale_locks_released,
    abandoned_files_marked_failed: summary.abandoned_files_marked_failed,
    job_locks_reclaimed: summary.job_locks_reclaimed,
    stuck_files_retried: summary.stuck_files_retried,
    files_permanently_failed: summary.files_permanently_failed,
    errors: summary.errors,
  }).then(({ error }) => {
    if (error) log('recovery_audit_log_write_failed', { error: error.message })
  })

  log('recovery_run_complete', {
    duration_ms: durationMs,
    document_recovery_enabled: !DOCUMENT_RECOVERY_DISABLED,
    ai_recovery_enabled: !AI_RECOVERY_DISABLED,
    ...summary,
  })

  return NextResponse.json({
    ran: true,
    duration_ms: durationMs,
    document_recovery_enabled: !DOCUMENT_RECOVERY_DISABLED,
    ai_recovery_enabled: !AI_RECOVERY_DISABLED,
    ...summary,
  })
}
