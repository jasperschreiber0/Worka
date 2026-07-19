-- Closes the gap traced live in production on 2026-07-19: recovery_classification_retriggered
-- firing every ~60s for the same batch/job (recovery_attempts climbing 1,1,2), each retrigger
-- re-running the full Stage 3 (Scope Reasoning) Claude call and never reaching Stage 6 (Estimate
-- Generation). Root cause, confirmed against code and the live log pattern: smooth-responder's
-- wall-clock safety budgets for Stage 3 (220s) and Stage 6 (150s) sum to more than
-- WALL_CLOCK_SAFETY_MS (340s) itself, so a project whose Stage 3 call genuinely takes ~190s+ can
-- never fit both stages in one invocation. bailForWallClockBudget (index.ts) previously only
-- logged and returned -- no terminal state, no persisted reason -- so the run exited "cleanly"
-- (releasing job_intake_locks via the existing try/finally), which made
-- find_stuck_batches_needing_classification_retry (migration 052) treat it as "classification
-- never reached smooth-responder" and retrigger it every cron tick, unconditionally re-running
-- Stage 3 each time because there was no durable signal that Stage 3 had already completed for
-- this batch (unlike project_documents.extraction_status for Stage 1/2, migration 050).
--
-- Two additions, both on document_processing_batches (the same row the recovery cron already
-- keys retries off via parent_job_id -- correctly per-upload-attempt scoped, so a genuinely NEW
-- upload to the same job still gets a fresh row and a fresh, un-skipped Stage 3 run):
--
--   1. scope_reasoning_completed_at -- set once, immediately after Stage 3 + Gap Detection finish
--      without a blocking clarifying question stopping the run. A retry of the SAME batch checks
--      this before calling Stage 3 again; if set, it skips straight to Stage 6 using the already-
--      persisted scope_items, so a retry becomes strictly cheaper (no repeated Stage 3 spend)
--      instead of repeating the same expensive call.
--
--   2. stall_stage / stall_reason / stalled_at / stall_count -- written by bailForWallClockBudget
--      on every wall-clock exit, so the batch is observable ("why is this still processing?")
--      instead of looking indistinguishable from a healthy in-progress run. Deliberately NOT
--      routed through files.ai_failure_classification/ai_failure_count (migration 042) -- this is
--      a scheduling condition (the invocation ran out of safe room to attempt a call), not a
--      content or model failure, and must not consume the Anthropic-failure retry budget that
--      exists to catch actually-deterministic bad documents.

alter table document_processing_batches
  add column if not exists scope_reasoning_completed_at timestamptz,
  add column if not exists stall_stage text,
  add column if not exists stall_reason text,
  add column if not exists stalled_at timestamptz,
  add column if not exists stall_count integer not null default 0;

comment on column document_processing_batches.scope_reasoning_completed_at is
  'Set once Stage 3 (Scope Reasoning) + Stage 4 (Gap Detection) finish for this batch without a blocking clarifying question stopping the run. A retry against the same batch (parent_job_id) skips re-running Stage 3 when this is set, reusing the already-persisted scope_items instead. Never set for a batch whose scope reasoning raised a blocking question -- that run legitimately needs Stage 3 re-run after the builder answers.';

comment on column document_processing_batches.stall_stage is
  'Name of the stage smooth-responder was about to start when it exited due to wall-clock budget exhaustion (bailForWallClockBudget) -- e.g. "reasoning_scope" or "generating_estimate". Null when the batch has never stalled.';

comment on column document_processing_batches.stall_reason is
  'Human-readable explanation of the most recent wall-clock stall, including elapsed/needed/ceiling milliseconds. Explicitly NOT a content/model failure -- a scheduling condition, distinct from files.ai_failure_classification.';

comment on column document_processing_batches.stalled_at is
  'Timestamp of the most recent wall-clock stall for this batch. Not cleared on a subsequent successful run -- see stall_count for whether it eventually converged.';

comment on column document_processing_batches.stall_count is
  'How many times this batch has hit a wall-clock stall across all invocations. Not currently used as a hard cap (the recovery cron''s own MAX_RECOVERY_ATTEMPTS already bounds retries for this batch); kept for observability and as the basis for a future cap if stalls are seen not to converge after the Stage 3 checkpoint fix above.';
