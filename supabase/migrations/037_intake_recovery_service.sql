-- ============================================================
-- WorkA — independent intake recovery service (breaks the self-triggering
-- deadlock in the document processing / estimating pipeline)
-- ============================================================
-- Context: every recovery mechanism added so far (migration 033's
-- last_progress_at heartbeat, migration 036's reclaim_stale_document_jobs)
-- is only ever INVOKED by the same chain of triggers that can fail in the
-- first place:
--   - reclaim_stale_document_jobs only runs inside claim_next_document_job,
--     which only runs inside a live document-worker invocation — but the
--     scenario it exists to recover FROM is "the document-worker chain has
--     stopped invoking itself entirely" (a single-document upload whose
--     one worker was CPU-killed has no sibling invocation left to ever
--     call claim_next_document_job again).
--   - job_intake_locks' staleness check only runs inside tryAcquireJobLock,
--     which only runs when a NEW upload arrives for the same job. If the
--     builder never re-uploads, a dead smooth-responder run's lock (and
--     the file stuck at intake_status='processing') sits forever.
--   - triggerClassification's fetch (document-worker/index.ts) and
--     triggerNext's fetch are both fire-and-forget with a swallowed catch
--     — a transient network failure there has no retry at all.
--
-- This migration adds the primitives an INDEPENDENT recovery cron (see
-- app/api/cron/intake-recovery/route.ts) uses to detect and resume every
-- one of these failure points on a fixed schedule, with no dependency on
-- any previously-running component still being alive. Every function here
-- is idempotent and safe to call repeatedly / concurrently — see each
-- function's own comment for the specific mechanism (SKIP LOCKED,
-- conditional UPDATE, or a re-derivation that is a no-op if already
-- correct).
-- ============================================================

-- ─── 1. Worker attribution — locked_by, for observability ──────────────────
-- Records which document-worker invocation (a random id minted per HTTP
-- request, not tied to any infrastructure identifier) is holding a
-- document_processing_jobs claim. Lets an operator reading structured logs
-- correlate "job X has been running since T, worker W claimed it" without
-- guessing — see the "next failure should be diagnosable from logs alone"
-- requirement. Purely observational; no code branches on this column.
ALTER TABLE document_processing_jobs
  ADD COLUMN IF NOT EXISTS locked_by text;

COMMENT ON COLUMN document_processing_jobs.locked_by IS
  'Random id minted by the document-worker invocation that last claimed this row (see workerId in document-worker/index.ts). Observability only — lets logs and stuck_document_jobs be correlated to a specific invocation.';

-- CREATE OR REPLACE cannot change a function's argument list — it would
-- CREATE a second, overloaded claim_next_document_job(uuid) alongside this
-- new claim_next_document_job(uuid, text) rather than replacing it, and any
-- single-argument call site (there are several — document-worker's own
-- fallback paths, the schema_assertions.sql callability probe) would then
-- fail with "function claim_next_document_job(uuid) is not unique" rather
-- than resolving to the new default-parameter overload. Drop the old
-- single-argument signature explicitly first so there is exactly one
-- version, callable with either one or two arguments via the default.
DROP FUNCTION IF EXISTS claim_next_document_job(uuid);

CREATE OR REPLACE FUNCTION claim_next_document_job(p_parent_job_id uuid, p_worker_id text DEFAULT NULL)
RETURNS SETOF document_processing_jobs AS $$
BEGIN
  PERFORM * FROM reclaim_stale_document_jobs(interval '3 minutes', p_parent_job_id);

  RETURN QUERY
  UPDATE document_processing_jobs
  SET status = 'running', locked_at = now(), locked_by = p_worker_id,
      started_at = COALESCE(started_at, now()), updated_at = now()
  WHERE id = (
    SELECT id FROM document_processing_jobs
    WHERE parent_job_id = p_parent_job_id AND status = 'pending' AND run_after <= now()
    ORDER BY created_at
    FOR UPDATE SKIP LOCKED
    LIMIT 1
  )
  RETURNING *;
END;
$$ LANGUAGE plpgsql;

-- ─── 2. Find batches whose worker chain has stopped but still has work ─────
-- After reclaim_stale_document_jobs resets a dead worker's row back to
-- 'pending' (or the row was simply never claimed in the first place — e.g.
-- the ONE worker invocation for a single-document upload died before ever
-- calling claim), nothing re-fires document-worker unless something new
-- decides to. This is that "something new": a plain read, safe to call as
-- often as needed, that tells the recovery cron exactly which batches need
-- a fresh document-worker invocation fired at them. Firing one invocation
-- is sufficient to resume the whole chain — see triggerNext in
-- document-worker/index.ts, which keeps calling claim_next_document_job
-- (each call sweeping stale rows again) until nothing pending remains.
CREATE OR REPLACE FUNCTION find_batches_with_claimable_work()
RETURNS TABLE(parent_job_id uuid, job_id uuid, builder_id uuid, pending_count bigint) AS $$
  SELECT b.id, b.job_id, b.builder_id, count(j.id)
  FROM document_processing_batches b
  JOIN document_processing_jobs j ON j.parent_job_id = b.id
  WHERE b.status IN ('pending', 'running')
    AND j.status = 'pending'
    AND j.run_after <= now()
  GROUP BY b.id, b.job_id, b.builder_id;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION find_batches_with_claimable_work IS
  'Batches with at least one claimable (pending, run_after due) document_processing_jobs row. Non-empty for a batch for more than a cron cycle means its worker chain has stopped self-sustaining (see triggerNext) — the recovery cron fires one fresh document-worker invocation per row returned, which is enough to resume the whole chain.';

-- ─── 3. Safety-net batch status recompute ──────────────────────────────────
-- recompute_parent_batch_status already runs transactionally inside
-- complete_document_job/retry_or_fail_document_job, so this should never
-- find anything in steady state. It exists purely as defense in depth —
-- e.g. a batch whose last child was reclaimed/failed by a process that
-- crashed between the child UPDATE and the recompute call (not possible
-- with the current single-statement RPCs, but cheap insurance against a
-- future refactor that splits them). Idempotent: recompute_parent_batch_
-- status itself only mutates rows that are still 'pending'/'running'.
CREATE OR REPLACE FUNCTION recompute_stalled_batches()
RETURNS TABLE(parent_job_id uuid, new_status text, should_trigger_classification boolean) AS $$
  SELECT stale.id, r.new_status, r.should_trigger_classification
  FROM (
    SELECT b.id
    FROM document_processing_batches b
    WHERE b.status IN ('pending', 'running')
      AND NOT EXISTS (
        SELECT 1 FROM document_processing_jobs j
        WHERE j.parent_job_id = b.id AND j.status IN ('pending', 'running')
      )
      AND EXISTS (SELECT 1 FROM document_processing_jobs j WHERE j.parent_job_id = b.id)
  ) stale(id)
  CROSS JOIN LATERAL recompute_parent_batch_status(stale.id) r;
$$ LANGUAGE sql;

COMMENT ON FUNCTION recompute_stalled_batches IS
  'Defense-in-depth only: re-derives status for any batch whose children are all terminal but the batch itself never left pending/running. Should be a no-op in steady state since recompute_parent_batch_status already runs transactionally with every child completion.';

-- ─── 4. Atomic job_intake_locks acquire-or-reclaim ─────────────────────────
-- Unifies what used to be two independent, slightly-racy implementations of
-- "steal a stale lock": app/api/intake/[fileId]/route.ts's tryAcquireJobLock
-- (INSERT, on 409 conflict SELECT-then-DELETE-then-INSERT — a real, if
-- narrow, window between the DELETE and the retry INSERT where a second
-- caller could both believe they'd acquired it) and the recovery cron
-- introduced by this migration, which needs the exact same "is this lock
-- actually stale" logic. Doing it as one atomic function removes that
-- window (SELECT ... FOR UPDATE holds the row lock across the staleness
-- check and the steal) and gives both callers one definition of "stale"
-- instead of two that could drift apart.
--
-- p_file_id is the file this caller wants the lock associated with once
-- acquired — for a fresh upload trigger that's the new file; for the
-- recovery cron reclaiming a dead run, it's the SAME file_id the dead lock
-- already recorded (resuming that run, not starting a different one).
CREATE OR REPLACE FUNCTION acquire_or_reclaim_job_intake_lock(
  p_job_id uuid,
  p_file_id uuid,
  p_no_progress_stale interval DEFAULT interval '6 minutes',
  p_absolute_stale interval DEFAULT interval '16 minutes'
)
RETURNS TABLE(acquired boolean, reclaimed_from_file_id uuid) AS $$
DECLARE
  v_row job_intake_locks;
BEGIN
  BEGIN
    INSERT INTO job_intake_locks (job_id, file_id) VALUES (p_job_id, p_file_id);
    RETURN QUERY SELECT true, NULL::uuid;
    RETURN;
  EXCEPTION WHEN unique_violation THEN
    NULL; -- someone holds it — fall through to the staleness check below
  END;

  SELECT * INTO v_row FROM job_intake_locks WHERE job_id = p_job_id FOR UPDATE;
  IF NOT FOUND THEN
    -- Raced with a concurrent release between the failed INSERT above and
    -- this SELECT — the row is free now.
    INSERT INTO job_intake_locks (job_id, file_id) VALUES (p_job_id, p_file_id);
    RETURN QUERY SELECT true, NULL::uuid;
    RETURN;
  END IF;

  IF (now() - v_row.last_progress_at > p_no_progress_stale)
     OR (now() - v_row.started_at > p_absolute_stale) THEN
    DELETE FROM job_intake_locks WHERE job_id = p_job_id;
    INSERT INTO job_intake_locks (job_id, file_id) VALUES (p_job_id, p_file_id);
    RETURN QUERY SELECT true, v_row.file_id;
    RETURN;
  END IF;

  RETURN QUERY SELECT false, NULL::uuid;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION acquire_or_reclaim_job_intake_lock IS
  'Atomic "insert, or steal if stale" for job_intake_locks — the single definition of lock staleness shared by the normal upload-trigger path and the recovery cron, closing the narrow steal-then-double-acquire race two separate REST-call implementations would otherwise be exposed to.';

-- ─── 5. Find stale job_intake_locks (read-only candidate list) ─────────────
-- A plain read so the recovery cron can log/report candidates before
-- acting; the actual reclaim decision is re-checked atomically by
-- acquire_or_reclaim_job_intake_lock at the moment of reclaim (this list
-- can be momentarily stale between the SELECT and the cron's next RPC call
-- — that's fine, the RPC re-verifies staleness itself).
CREATE OR REPLACE FUNCTION find_stale_job_intake_locks(
  p_no_progress_stale interval DEFAULT interval '6 minutes',
  p_absolute_stale interval DEFAULT interval '16 minutes'
)
RETURNS TABLE(job_id uuid, file_id uuid, started_at timestamptz, last_progress_at timestamptz, stale_for interval) AS $$
  SELECT l.job_id, l.file_id, l.started_at, l.last_progress_at,
         GREATEST(now() - l.last_progress_at, now() - l.started_at)
  FROM job_intake_locks l
  WHERE (now() - l.last_progress_at > p_no_progress_stale)
     OR (now() - l.started_at > p_absolute_stale);
$$ LANGUAGE sql STABLE;

-- ─── 6. Find files whose batch finished but classification never started ──
-- Closes the gap where document-worker's triggerClassification fetch
-- (index.ts) itself fails or is lost (its catch only logs, never retries):
-- classification_triggered is already true and every document extracted
-- successfully, but smooth-responder was never actually reached, so no
-- job_intake_locks row was ever created for this job and files.intake_status
-- never advances past 'processing'. p_grace gives a normal in-flight
-- trigger time to land before this is treated as failed-to-fire.
CREATE OR REPLACE FUNCTION find_stuck_files_needing_classification_retry(p_grace interval DEFAULT interval '3 minutes')
RETURNS TABLE(file_id uuid, job_id uuid, builder_id uuid, processing_batch_id uuid) AS $$
  SELECT f.id, f.job_id, f.builder_id, f.processing_batch_id
  FROM files f
  JOIN document_processing_batches b ON b.id = f.processing_batch_id
  WHERE f.intake_status = 'processing'
    AND b.status IN ('completed', 'completed_with_failures', 'failed')
    AND b.classification_triggered = true
    AND b.updated_at < now() - p_grace
    AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = f.job_id);
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION find_stuck_files_needing_classification_retry IS
  'Files whose document-processing batch finished and flipped classification_triggered, but no job_intake_locks row ever appeared for the job — evidence the triggerClassification fetch to smooth-responder was itself lost (network blip, cold start) rather than smooth-responder having started and died. The recovery cron re-fires smooth-responder directly for these.';

-- ─── 7. Recovery run audit log ──────────────────────────────────────────────
-- A persistent, queryable record of every recovery cron execution —
-- structured console logs from a serverless function have limited
-- retention and aren't queryable with SQL. This is what makes "the next
-- failure should be diagnosable from logs alone" true days later, not just
-- while the Vercel/Supabase log stream still has the run.
CREATE TABLE IF NOT EXISTS intake_recovery_runs (
  id                          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  run_started_at              timestamptz NOT NULL,
  run_finished_at             timestamptz,
  duration_ms                 integer,
  document_jobs_reclaimed     integer     NOT NULL DEFAULT 0,
  stalled_batches_recomputed  integer     NOT NULL DEFAULT 0,
  batches_resumed             integer     NOT NULL DEFAULT 0,
  job_locks_reclaimed         integer     NOT NULL DEFAULT 0,
  stuck_files_retried         integer     NOT NULL DEFAULT 0,
  errors                      jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at                  timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE intake_recovery_runs IS
  'One row per app/api/cron/intake-recovery execution. Persistent audit trail of what the independent recovery service found and fixed, so a stuck-pipeline incident can be diagnosed (was recovery even running? did it find the stuck row? did re-triggering fail?) without depending on ephemeral function log retention.';

-- No RLS: this is an internal operational table, never queried with a
-- builder's session token (only the service-role cron route writes/reads
-- it), and carries no builder-identifying data beyond opaque ids already
-- covered by RLS on the tables those ids reference.
