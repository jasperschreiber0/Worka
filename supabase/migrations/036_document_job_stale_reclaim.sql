-- ============================================================
-- WorkA — document_processing_jobs stale-running reclaim
-- ============================================================
-- Context: document-worker's HTTP handler returns 202 "claimed" immediately
-- after claim_next_document_job sets status='running', then does the actual
-- extraction inside EdgeRuntime.waitUntil (see index.ts) — i.e. the caller
-- that could have noticed a failure has already gone away before the real
-- work even starts. If that background work is killed by Supabase's
-- external, uncatchable CPU-time governor (the same failure mode migration
-- 033 addressed for job_intake_locks), the job's row is left at
-- status='running' with a locked_at that never advances again. No code path
-- ever calls complete_document_job or retry_or_fail_document_job for it, so
-- recompute_parent_batch_status never sees it leave 'running' — the parent
-- batch never becomes terminal, classification never triggers, and the row
-- sits stuck until a human intervenes. This is the queue-model analogue of
-- the job_intake_locks staleness gap; migration 033 already established the
-- reclaim pattern this borrows.
--
-- Why a fixed staleness window is sufficient here (unlike job_intake_locks,
-- which needed a *heartbeat* column because a single smooth-responder run
-- can legitimately take minutes across several stages/batches): one
-- document_processing_jobs claim does exactly one document's extraction,
-- bounded by the same ~2000ms per-request CPU budget this whole model
-- exists to isolate, plus ordinary I/O (storage download, a couple of RPCs).
-- There is no legitimate multi-minute in-progress state to distinguish from
-- a dead one. p_stale_after defaults to 3 minutes — comfortably above any
-- real run, comfortably below making a builder wait to recover from a dead
-- one.
--
-- Reclaim strategy: route a stale 'running' row through the exact same
-- retry_or_fail_document_job semantics a genuine catchable failure would
-- get (same backoff schedule, same MAX_DOCUMENT_JOB_ATTEMPTS-equivalent cap
-- of 3 attempts, same terminal 'failed' state and batch-recompute on
-- exhaustion) rather than inventing a second failure pathway with its own
-- rules.
--
-- Invocation: folded into claim_next_document_job itself (self-healing on
-- every claim attempt, scoped to that call's own parent_job_id) rather than
-- requiring a new cron/health-endpoint — this mirrors tryAcquireJobLock's
-- own lazy-reclaim-on-acquire pattern in app/api/intake/[fileId]/route.ts.
-- reclaim_stale_document_jobs is still exposed standalone so a health check
-- or monitoring view can also report/sweep across all batches, not only the
-- one a worker happens to be claiming against right now.
-- ============================================================

-- p_parent_job_id: NULL (the default) sweeps every batch — for standalone
-- use by a health check or monitoring cron. claim_next_document_job passes
-- its own parent_job_id so a worker's claim only ever pays the cost of
-- sweeping the one batch it's already querying, not the whole table.
CREATE OR REPLACE FUNCTION reclaim_stale_document_jobs(
  p_stale_after interval DEFAULT interval '3 minutes',
  p_parent_job_id uuid DEFAULT NULL
)
RETURNS TABLE(reclaimed_job_id uuid, reclaimed_parent_job_id uuid, new_status text) AS $$
DECLARE
  v_job record;
  v_result record;
BEGIN
  FOR v_job IN
    SELECT id, parent_job_id
    FROM document_processing_jobs
    WHERE status = 'running' AND locked_at IS NOT NULL AND locked_at < now() - p_stale_after
      AND (p_parent_job_id IS NULL OR parent_job_id = p_parent_job_id)
    ORDER BY locked_at
    FOR UPDATE SKIP LOCKED
  LOOP
    -- FOR UPDATE SKIP LOCKED above means a worker that is, against
    -- expectations, still genuinely holding this row (mid-transaction) is
    -- simply skipped this sweep rather than double-processed — it becomes
    -- reclaimable on the next sweep if it really is stale.
    SELECT r.new_status, r.should_trigger_classification
    INTO v_result
    FROM retry_or_fail_document_job(
      v_job.id,
      format('reclaimed: stale running job, no update since %s (worker invocation likely crashed or was killed)', p_stale_after),
      3
    ) r;

    reclaimed_job_id := v_job.id;
    reclaimed_parent_job_id := v_job.parent_job_id;
    new_status := v_result.new_status;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reclaim_stale_document_jobs IS
  'Requeues (or permanently fails, past 3 attempts) any document_processing_jobs row stuck at status=''running'' with a locked_at older than p_stale_after — the queue-model analogue of job_intake_locks'' staleness reclaim (migration 033). Safe to call repeatedly; FOR UPDATE SKIP LOCKED means a row a worker is still genuinely processing is never double-handled.';

-- claim_next_document_job now sweeps this batch's own stale rows before
-- attempting its claim, so every worker invocation is a reclaim opportunity
-- with no separate cron required. This is the only behavioural change to
-- the function; the claim logic itself (FOR UPDATE SKIP LOCKED on the
-- pending set) is unchanged.
CREATE OR REPLACE FUNCTION claim_next_document_job(p_parent_job_id uuid)
RETURNS SETOF document_processing_jobs AS $$
BEGIN
  PERFORM * FROM reclaim_stale_document_jobs(interval '3 minutes', p_parent_job_id);

  RETURN QUERY
  UPDATE document_processing_jobs
  SET status = 'running', locked_at = now(), started_at = COALESCE(started_at, now()), updated_at = now()
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
