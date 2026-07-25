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

// Phase 1 observation phase: how many non-terminal batches this run will
// sweep through reconcile_estimate_run, independent of whether recovery
// itself touched them. Production sampling during the observation phase
// (find_estimate_run_mismatches) showed the two existing call sites (SSE
// poll ticks, and recovery only reconciling batches it actively acted on)
// left ~95% of batches never reconciled at all -- a batch that's
// processing normally, or whose job sits behind another job's lock, gets
// no SSE client still polling it and needs no recovery action, so nothing
// ever calls reconcile_estimate_run for it. This sweep closes that
// coverage gap without changing what recovery decides or acts on -- it's
// the same read-only, best-effort RPC every other call site already uses,
// just called for more rows. Bounded like every other step here for the
// same reason (a systemic issue must not turn one cron run into unbounded
// work).
const MAX_RECONCILE_SWEEP_PER_RUN = 100

interface RunSummary {
  document_jobs_reclaimed: number
  stalled_batches_recomputed: number
  batches_resumed: number
  stale_locks_released: number
  abandoned_files_marked_failed: number
  job_locks_reclaimed: number
  stuck_files_retried: number
  files_permanently_failed: number
  deadlines_enforced: number
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
//   chunked-file dedup, atomic counter) were built to close.
//
// RE-ENABLED (was disabled pending a manually-observed production run of
// that redesign — see git history for the long analysis). Every specific
// cause of the original incident is now independently closed and was
// re-verified against this exact code before flipping the flag:
//   - identical-payload resend -> solo-forcing on ai_failure_count>=1
//     (a solo request is strictly smaller than what just failed)
//   - no retry cap -> maxConsecutiveOccurrences, enforced INSIDE
//     record_ai_failure (migration 043) regardless of trigger source, so
//     this cron's re-triggers are bound by the exact same cap a live
//     client's retry is
//   - billing failure not stopping the run -> haltForBilling marks the
//     file 'failed' immediately, which both this file's own exclusion
//     query and the Stage 1/2 batch-planning filter correctly skip going
//     forward — a billing outage costs at most MAX_LOCKS_PER_RUN +
//     MAX_STUCK_FILES_PER_RUN wasted calls, once, self-terminating
//   - runaway/unclean invocation death -> the wall-clock budget guard
//     (supabase/functions/smooth-responder/index.ts) means every
//     invocation this cron triggers now stops itself cleanly with margin
//     to spare and releases job_intake_locks promptly, instead of ever
//     being killed uncleanly mid-flight
//   - redundant reclassification burning extra spend on every retry ->
//     project_documents.extraction_status (migration 050) means a
//     cron-triggered retry can't re-spend on work already durably done
//
// RE-DISABLED AGAIN (2026-07-20) — live incident, root cause now found and
// fixed at the source (supabase/functions/smooth-responder/index.ts's
// existingFacts query gained a missing `.order('id')` — see that file's own
// comment). Deploy logs from this morning showed recovery_classification_
// retriggered firing every single cron tick (~60s) for the same 3 batches,
// indefinitely: stage3_trades_already_completed stuck at 0 and resume_kind
// always fresh_or_unstarted, meaning Stage 3's own circuit breaker
// (shouldSkipStage3Call/record_stage3_failure, migration 059 — built
// specifically to stop exactly this) never engaged. Root cause: that
// breaker keys on a hash of the Stage 3 prompt (stage3InputHash), computed
// from a facts array whose DB query had no ORDER BY — Postgres gives no
// row-order guarantee without one, so an UNCHANGED fact base was hashing
// differently on every retry, permanently defeating the "same input failed
// before, don't resend it" check. Genuine, real Anthropic spend every
// minute with no cap in sight (files.intake_recovery_attempts also
// observed NOT advancing across consecutive ticks in the same logs — a
// second, still-unconfirmed symptom worth checking once this is back on,
// see intake_recovery_runs / files.intake_recovery_attempts history).
// Do not flip this back to false until: (1) the ORDER BY fix has been
// deployed (supabase-functions-deploy.yml runs on push to
// supabase/functions/**), (2) a real retriggered batch is watched end-to-
// end to confirm stage3_failure_count now actually accumulates against a
// STABLE input hash and the breaker trips after maxConsecutiveOccurrences,
// and (3) files.intake_recovery_attempts is confirmed to be genuinely
// monotonic across ticks for a repeatedly-retried file, not just assumed
// fixed as a side effect of (1).
//
// STILL DISABLED (2026-07-19) — deliberately NOT re-enabled in the same
// pass that re-enabled AI_RECOVERY_DISABLED below. Root cause now traced
// (previously "not yet isolated"), but not fixed, and this is a genuinely
// separate bug from the wall-clock issue AI_RECOVERY_DISABLED covered:
//
//   find_and_fail_abandoned_files (migration 046) does a direct
//   `UPDATE files SET intake_status = 'failed'`. But migration 052
//   redefined files.intake_status as a DERIVED, recomputed-and-overwritten
//   projection — document-worker's own recompute_file_intake_status call
//   (index.ts:403, fired after step 1/3's reclaim-and-retrigger) re-derives
//   'processing' from the file's document_processing_jobs row whenever that
//   row is still non-terminal. For a file whose worker keeps dying before
//   completing (the exact profile find_and_fail_abandoned_files exists to
//   catch), steps 1+3 (reclaim, then re-trigger a fresh document-worker
//   invocation) and step 3c (mark it failed if stale) race every single
//   cron tick: 3c marks it 'failed', the freshly-retriggered worker
//   eventually calls recompute_file_intake_status and flips it back to
//   'processing' (since the underlying job row never reaches a terminal
//   state), and the next tick's 3c sees 'processing' again — a genuine,
//   non-converging oscillation, not a one-off.
//
// RE-ENABLED (2026-07-25) — migration 075 implements exactly the fix this
// comment proposed: reclaim_stale_document_jobs and
// find_batches_with_claimable_work now both exclude any document_processing_
// jobs row whose file already carries intake_status='failed' AND
// failure_stage='ABANDONED'. That closes the race precisely: a file
// find_and_fail_abandoned_files (step 3c, below) has just declared
// terminal can no longer be reclaimed or re-triggered by steps 1/3, so
// nothing calls recompute_file_intake_status for it again, so it can never
// be flipped back to 'processing' and re-fail on the next tick. The
// hypothesis this comment used to describe as unconfirmed is now the
// mechanism the fix directly targets — re-disable immediately (set back to
// true) if recovery_document_jobs_reclaimed/abandoned_files_marked_failed
// in intake_recovery_runs still show the same file(s) cycling repeatedly
// after this deploy; that would mean the oscillation has a second cause
// beyond the one migration 075 closes.
const DOCUMENT_RECOVERY_DISABLED = false
// ACTUALLY RE-ENABLED NOW (2026-07-24) — the 2026-07-19 comment above
// already documented every reason this was safe to flip back on (chunked
// Stage 3 resumability via stage3_completed_trade_ids/planStage3Chunks,
// the retry cap, billing halt, wall-clock self-termination), but the
// const itself was left at `true`, so none of that ever actually ran:
// this is what was silently preventing ANY stalled batch — classification
// OR Stage 3 OR Stage 6 running out of wall-clock room — from ever being
// resumed. Confirmed as the live blocker on the Alfred St job: extraction
// completes, classification succeeds for whichever documents get a Claude
// call this invocation, and the run cleanly bails (stall_stage/stall_reason
// persisted, lock released) once WALL_CLOCK_SAFETY_MS is spent — but with
// this flag on, steps 4-5 (the only path that re-triggers smooth-responder
// for an already-stalled batch) never ran, so nothing ever picked it back
// up. Paired with a classification-loop budget reserve (smooth-responder/
// index.ts) so a batch that DOES get retriggered is less likely to spend
// its entire fresh window on more Stage 1/2 work before Stage 3 gets a
// look-in. Re-disable immediately (set back to true) if retrigger-storm
// behavior (recovery_classification_retriggered firing every tick for the
// same batch with stage3_trades_already_completed stuck at 0) is observed
// again — intake_recovery_runs / recovery_classification_retriggered logs
// are the fastest way to confirm convergence.
const AI_RECOVERY_DISABLED = false

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
    deadlines_enforced: 0,
    errors: [],
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  // ── 0. Enforce the 15-minute estimate SLA (migration 078) — independent of
  // DOCUMENT_RECOVERY_DISABLED/AI_RECOVERY_DISABLED, deliberately: finalizing
  // a builder_status makes no Anthropic call and triggers no worker, so
  // there is no reason this should ever wait on either kill switch. This is
  // what guarantees a builder returning after 15 minutes always finds
  // ESTIMATE_READY / ESTIMATE_READY_WITH_WARNINGS / NEEDS_REVIEW, never
  // silence — and, since find_stuck_batches_needing_classification_retry /
  // find_batches_with_claimable_work now exclude any batch with a finalized
  // builder_status (migration 078), running this FIRST means a run whose
  // deadline just passed is correctly excluded from retriggering later in
  // this SAME tick, not just on the next one.
  try {
    const { data, error } = await supabase.rpc('enforce_estimate_deadlines')
    if (error) throw error
    const enforced = (data ?? []) as Array<{ estimate_run_id: string; job_id: string; batch_id: string; builder_status: string; reason: string }>
    summary.deadlines_enforced = enforced.length
    for (const e of enforced) {
      log('estimate_deadline_enforced', {
        estimate_run_id: e.estimate_run_id, job_id: e.job_id, batch_id: e.batch_id,
        builder_status: e.builder_status, reason: e.reason,
      })
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    summary.errors.push({ stage: 'enforce_estimate_deadlines', message })
    log('recovery_stage_failed', { stage: 'enforce_estimate_deadlines', error: message })
  }

  // Phase 1, increment 1 (migration 056): estimate_runs is a derived
  // projection reconciled from the same tables/RPCs this route already
  // reads and writes — collected here purely so every batch this run
  // TOUCHED gets its projection refreshed at the end, alongside (never
  // instead of) the real recovery work above. See reconcile_estimate_run's
  // own comment: read-only against everything but estimate_runs, so this
  // can never affect what recovery actually does, only how quickly the
  // projection catches up to it.
  const touchedBatchIds = new Set<string>()

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
      toResume.forEach((b) => touchedBatchIds.add(b.parent_job_id))
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

  // Check the global AI circuit breaker BEFORE deciding to retrigger
  // anything — closes a real gap found live (2026-07-25): steps 4-5 had no
  // awareness of system_status.ai_circuit_breaker at all, so even after an
  // operator manually tripped it (or it auto-tripped, migration 054/077),
  // this route kept invoking smooth-responder every ~60s regardless —
  // pointless (the gateway's own checkBudget refuses the call downstream
  // either way, so no additional Anthropic spend resulted) but noisy, and
  // worse, it meant a billing-halted batch's failure was never attributed
  // to the real cause in this route's own logs. A tripped breaker is an
  // account-level condition (e.g. Anthropic credit exhausted, confirmed
  // live via 203 credit_exhausted ai_operations rows over 90+ minutes on
  // this exact incident) — retrying can never fix it, only spending more
  // effort reproducing the identical refusal.
  let aiCircuitBreakerTripped = false
  try {
    const { data: breakerRow } = await supabase
      .from('system_status')
      .select('value')
      .eq('key', 'ai_circuit_breaker')
      .single()
    aiCircuitBreakerTripped = Boolean((breakerRow?.value as { tripped?: boolean } | null)?.tripped)
  } catch (err) {
    // Fail closed is the wrong instinct here specifically — if this read
    // fails, we don't know the breaker's state, and the existing per-batch/
    // per-file retry caps (MAX_RECOVERY_ATTEMPTS, stage3/6 escalation,
    // total_ai_call_attempts) still bound the worst case even without this
    // additional gate. Log and proceed rather than silently skip recovery
    // over a transient read failure.
    log('recovery_stage_failed', { stage: 'ai_circuit_breaker_check', error: err instanceof Error ? err.message : String(err) })
  }

  if (AI_RECOVERY_DISABLED || aiCircuitBreakerTripped) {
    log('recovery_ai_steps_skipped', {
      reason: AI_RECOVERY_DISABLED ? 'AI_RECOVERY_DISABLED' : 'ai_circuit_breaker_tripped',
    })
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
            // job_intake_locks.file_id is always the run's primary/anchor
            // file (set by tryAcquireJobLock at upload time, or by step 5
            // above using the batch's primary_file_id) — never a sibling —
            // and the primary file's intake_status is still an explicit
            // terminal write at the real end of the pipeline (fail()/
            // needs_info/success in smooth-responder), just applied via the
            // derived recompute path since migration 052 rather than a
            // literal inline value. document_processing_batches.status is
            // NOT a substitute here: it reflects only the extraction-queue
            // portion (done well before Stage 3-6 concludes) and would
            // read 'completed' for the entire, legitimate duration of a
            // still-running smooth-responder invocation.
            const { data: fileRow, error: fileRowErr } = await supabase
              .from('files')
              .select('id, intake_status, builder_id, processing_batch_id')
              .eq('id', candidate.file_id)
              .single()
            if (fileRowErr) throw fileRowErr
            if (!fileRow || ['extracted', 'failed', 'needs_info'].includes(fileRow.intake_status)) {
              await supabase.from('job_intake_locks').delete().eq('job_id', candidate.job_id)
              continue
            }

            // SLA eligibility (migration 078): "is this incomplete AND still
            // eligible for recovery" — this path (job_intake_locks reclaim)
            // isn't covered by the builder_status exclusion baked into
            // find_stuck_batches_needing_classification_retry/find_batches_
            // with_claimable_work (those key off document_processing_batches,
            // this one off job_intake_locks directly), so it's checked
            // explicitly here. A batch whose 15-minute deadline has already
            // passed is not "eligible for recovery" regardless of remaining
            // retry-attempt budget — enforce_estimate_deadlines (step 0,
            // above) already finalized its builder_status this same tick, so
            // simply not retriggering it is enough; no separate lock cleanup
            // needed here since that finalization didn't touch the lock.
            if (fileRow.processing_batch_id) {
              const { data: runRow } = await supabase
                .from('estimate_runs')
                .select('deadline_at, builder_status')
                .eq('batch_id', fileRow.processing_batch_id)
                .maybeSingle()
              if (runRow?.builder_status || (runRow?.deadline_at && new Date(runRow.deadline_at).getTime() < Date.now())) {
                await supabase.from('job_intake_locks').delete().eq('job_id', candidate.job_id)
                log('recovery_skipped_past_deadline', { job_id: candidate.job_id, file_id: candidate.file_id, batch_id: fileRow.processing_batch_id })
                continue
              }
            }

            // Retry cap: a lock that keeps going stale means the pipeline run
            // it's protecting keeps dying (or failing) every single time — most
            // often a transient outage (e.g. Anthropic credits) that recovery
            // cannot fix by re-running the same expensive AI call again. Stop
            // after MAX_RECOVERY_ATTEMPTS rather than retrying forever.
            // Atomic RPC (migration 051) — a plain JS-side SELECT-then-UPDATE
            // here previously let a read/write failure (e.g. a stale
            // PostgREST schema cache) silently default to "first attempt"
            // forever, defeating this cap in production. Any RPC error is
            // thrown, not swallowed, so it surfaces via this block's own
            // catch instead of masquerading as attempt zero.
            const { data: attemptData, error: attemptErr } = await supabase.rpc('record_intake_recovery_attempt', {
              p_file_id: candidate.file_id,
              p_max_attempts: MAX_RECOVERY_ATTEMPTS,
              p_cap_reason: `Automatic recovery retry cap (${MAX_RECOVERY_ATTEMPTS}) reached while reclaiming a stale processing lock — processing failed to complete repeatedly and was stopped to prevent runaway retries. Manual re-upload required.`,
            })
            if (attemptErr) throw attemptErr
            const attemptResult = attemptData?.[0]
            if (attemptResult?.capped) {
              await supabase.from('job_intake_locks').delete().eq('job_id', candidate.job_id)
              summary.files_permanently_failed++
              log('recovery_retry_cap_reached', {
                stage: 'stale_lock_reclaim', job_id: candidate.job_id, file_id: candidate.file_id,
                attempts: attemptResult.prior_attempts,
              })
              continue
            }

            summary.job_locks_reclaimed++
            if (fileRow.processing_batch_id) touchedBatchIds.add(fileRow.processing_batch_id)
            log('recovery_job_lock_reclaimed', { job_id: candidate.job_id, file_id: candidate.file_id, processing_batch_id: fileRow.processing_batch_id, recovery_attempts: (attemptResult?.prior_attempts ?? 0) + 1 })

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
      // Discovery is keyed on the batch itself (migration 052's
      // find_stuck_batches_needing_classification_retry), not on any one
      // file's files.intake_status/processing_batch_id — those were only
      // ever populated for a batch's primary/anchor file, so the previous
      // file-keyed version could structurally only ever surface a batch
      // whose primary file itself was left stuck. document_processing_batches
      // already carries everything this needs natively.
      try {
        const { data, error } = await supabase.rpc('find_stuck_batches_needing_classification_retry')
        if (error) throw error
        const stuckBatches = (data ?? []) as Array<{ batch_id: string; job_id: string; builder_id: string; primary_file_id: string }>
        const toRetry = stuckBatches.slice(0, MAX_STUCK_FILES_PER_RUN)
        if (stuckBatches.length > MAX_STUCK_FILES_PER_RUN) {
          log('recovery_stuck_files_cap_hit', { candidates: stuckBatches.length, capped_to: MAX_STUCK_FILES_PER_RUN })
        }

        for (const b of toRetry) {
          // acquire_or_reclaim_job_intake_lock also guards this path — if a
          // fresh upload or a step 4 reclaim just started a run for this same
          // job, this simply fails to acquire and is skipped, never double-fires.
          // p_file_id is informational on job_intake_locks (job_id is the
          // real key) — the batch's primary_file_id is as good an anchor as
          // any, matching what the original upload session would have used.
          const { data: lockData, error: lockErr } = await supabase.rpc('acquire_or_reclaim_job_intake_lock', {
            p_job_id: b.job_id,
            p_file_id: b.primary_file_id,
          })
          if (lockErr || !lockData?.[0]?.acquired) continue

          // Retry cap via the same atomic RPC as step 4 (migration 051) —
          // a batch that keeps needing a classification retry is failing
          // every time it's re-triggered, not recovering from a one-off
          // lost network call. Keyed on the batch's primary_file_id, same
          // as the lock above — one counter per batch/run, not per document.
          const { data: attemptData, error: attemptErr } = await supabase.rpc('record_intake_recovery_attempt', {
            p_file_id: b.primary_file_id,
            p_max_attempts: MAX_RECOVERY_ATTEMPTS,
            p_cap_reason: `Automatic recovery retry cap (${MAX_RECOVERY_ATTEMPTS}) reached while retrying classification — processing failed to complete repeatedly and was stopped to prevent runaway retries. Manual re-upload required.`,
          })
          if (attemptErr) {
            const message = attemptErr instanceof Error ? attemptErr.message : String(attemptErr)
            summary.errors.push({ stage: `record_intake_recovery_attempt:${b.primary_file_id}`, message })
            log('recovery_stage_failed', { stage: 'record_intake_recovery_attempt', file_id: b.primary_file_id, error: message })
            continue
          }
          const attemptResult = attemptData?.[0]
          if (attemptResult?.capped) {
            await supabase.from('job_intake_locks').delete().eq('job_id', b.job_id)
            summary.files_permanently_failed++
            log('recovery_retry_cap_reached', {
              stage: 'stuck_classification_retry', job_id: b.job_id, file_id: b.primary_file_id, attempts: attemptResult.prior_attempts,
            })
            continue
          }

          summary.stuck_files_retried++
          touchedBatchIds.add(b.batch_id)
          // Clear audit distinction (2026-07-19 wall-clock redesign): a
          // retrigger of a batch with real Stage 3 progress already
          // persisted (stage3_completed_trade_ids non-empty, migration 060)
          // is a CONVERGING resume, not a repeat of a doomed identical call
          // — surfaced explicitly here so an operator reading logs doesn't
          // have to guess whether a given retrigger is making progress or
          // looping. The retry cap above still applies identically either
          // way; this is observability only, not a second enforcement path.
          const { data: progressRow } = await supabase
            .from('document_processing_batches')
            .select('stage3_completed_trade_ids')
            .eq('id', b.batch_id)
            .single()
          const tradesAlreadyDone = (progressRow?.stage3_completed_trade_ids as number[] | null)?.length ?? 0
          log('recovery_classification_retriggered', {
            job_id: b.job_id, file_id: b.primary_file_id, processing_batch_id: b.batch_id,
            recovery_attempts: (attemptResult?.prior_attempts ?? 0) + 1,
            stage3_trades_already_completed: tradesAlreadyDone,
            resume_kind: tradesAlreadyDone > 0 ? 'converging_partial_progress' : 'fresh_or_unstarted',
          })
          await fetch(`${supabaseUrl}/functions/v1/smooth-responder`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${anonKey}` },
            body: JSON.stringify({ parent_job_id: b.batch_id }),
          }).catch((fetchErr) => {
            log('recovery_smooth_responder_trigger_failed', { job_id: b.job_id, error: String(fetchErr) })
          })
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        summary.errors.push({ stage: 'find_stuck_batches_needing_classification_retry', message })
        log('recovery_stage_failed', { stage: 'find_stuck_batches_needing_classification_retry', error: message })
      }
  }

  // Coverage sweep (see MAX_RECONCILE_SWEEP_PER_RUN above): reconcile every
  // batch this run hasn't already touched that either (a) already has a
  // non-terminal estimate_runs row (shrinks reconciliation lag beyond what
  // SSE polling alone gives), or (b) has never been reconciled at all
  // (find_estimate_run_mismatches flags these via has_estimate_run=false —
  // reused here rather than adding a second, differently-shaped finder, so
  // the sweep and the audit tool agree on what counts as unreconciled).
  // Purely observational — never calls Anthropic, never triggers
  // document-worker/smooth-responder, never affects any decision this
  // route makes.
  try {
    const { data: mismatches, error } = await supabase
      .from('estimate_runs')
      .select('batch_id')
      .not('status', 'in', '(complete,failed)')
    if (error) throw error
    const { data: unreconciled, error: unreconciledErr } = await supabase.rpc('find_estimate_run_mismatches')
    if (unreconciledErr) throw unreconciledErr
    const sweepCandidates = new Set<string>([
      ...((mismatches ?? []) as Array<{ batch_id: string }>).map((r) => r.batch_id),
      ...((unreconciled ?? []) as Array<{ batch_id: string; has_estimate_run: boolean }>)
        .filter((r) => !r.has_estimate_run)
        .map((r) => r.batch_id),
    ])
    touchedBatchIds.forEach((id) => sweepCandidates.delete(id))
    const sweepList = Array.from(sweepCandidates).slice(0, MAX_RECONCILE_SWEEP_PER_RUN)
    if (sweepCandidates.size > MAX_RECONCILE_SWEEP_PER_RUN) {
      log('recovery_reconcile_sweep_cap_hit', { candidates: sweepCandidates.size, capped_to: MAX_RECONCILE_SWEEP_PER_RUN })
    }
    sweepList.forEach((id) => touchedBatchIds.add(id))
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    summary.errors.push({ stage: 'estimate_run_reconcile_sweep', message })
    log('recovery_stage_failed', { stage: 'estimate_run_reconcile_sweep', error: message })
  }

  // Refresh the estimate_runs projection for every batch this run actually
  // touched (recovery actions above, plus the coverage sweep just above).
  // Best-effort and parallel — a failure here never affects recovery's own
  // outcome (already committed above) or this run's audit row below, only
  // how current the projection is for that batch.
  if (touchedBatchIds.size > 0) {
    const reconcileResults = await Promise.allSettled(
      Array.from(touchedBatchIds).map((batchId) =>
        supabase.rpc('reconcile_estimate_run', { p_batch_id: batchId })
      )
    )
    const reconcileFailures = reconcileResults.filter((r) => r.status === 'rejected').length
    if (reconcileFailures > 0) {
      log('recovery_estimate_run_reconcile_failed', { count: reconcileFailures, of: touchedBatchIds.size })
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
    ai_circuit_breaker_tripped: aiCircuitBreakerTripped,
    ...summary,
  })

  return NextResponse.json({
    ran: true,
    duration_ms: durationMs,
    document_recovery_enabled: !DOCUMENT_RECOVERY_DISABLED,
    ai_recovery_enabled: !AI_RECOVERY_DISABLED,
    ai_circuit_breaker_tripped: aiCircuitBreakerTripped,
    ...summary,
  })
}
