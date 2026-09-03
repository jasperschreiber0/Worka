-- ============================================================
-- WorkA — find_stuck_batches_needing_classification_retry(): add fair,
-- oldest-first ordering so a backlog can't starve a newer batch
-- ============================================================
-- Production evidence (fresh E2E test, job 4f8824d2, 2026-09-03): batch
-- 85b7a359 stalled mid-Stage-6 (6/8 trades) at 08:53:36. Its 3-minute grace
-- period cleared at 08:56:36. Every clause of this function's predicate was
-- independently confirmed true for this batch from 08:56:36 onward (status
-- terminal, classification_triggered, past grace, stage3/6 failure counts
-- zero, no job_intake_lock, no finalized estimate_run, no unresolved AI
-- failure) -- yet GET /api/cron/intake-recovery's step 5 (route.ts) reported
-- batches_resumed=0 on every single one of the ~9 one-minute ticks between
-- 08:57:00 and 09:05:00, despite running every minute with zero errors.
--
-- Root cause: this function's SELECT has no ORDER BY, and its caller caps
-- consumption at MAX_STUCK_FILES_PER_RUN=10 per tick
-- (stuckBatches.slice(0, MAX_STUCK_FILES_PER_RUN)). Postgres gives no
-- ordering guarantee for an unordered SELECT -- in practice a heap scan
-- tends to surface older rows first. This session's own testing has left a
-- substantial backlog of older stalled/failed batches in production. Under
-- that backlog, a newer eligible batch can be pushed past the 10-per-tick
-- cap indefinitely (or for an unbounded number of minutes), even though the
-- cron itself runs correctly every 60 seconds with room to spare -- this is
-- the exact same starvation shape already found and understood earlier this
-- session in the pricing/QA backfill sweep (migration 092/093's own
-- candidate query), just in the batch-retry path instead.
--
-- Fix: add `ORDER BY b.updated_at ASC` -- oldest-stalled-batch-first. This
-- guarantees fairness: every eligible batch is retried within
-- ceil(backlog_size / MAX_STUCK_FILES_PER_RUN) ticks (roughly one minute
-- per ten batches of backlog) instead of being at the mercy of an
-- unspecified, unstable scan order that could starve it far longer. No
-- other behavior changes -- same predicate, same cap, same caller logic.
CREATE OR REPLACE FUNCTION find_stuck_batches_needing_classification_retry(p_grace interval DEFAULT interval '3 minutes')
RETURNS TABLE(batch_id uuid, job_id uuid, builder_id uuid, primary_file_id uuid)
LANGUAGE sql
STABLE
AS $function$
  SELECT b.id, b.job_id, b.builder_id, b.primary_file_id
  FROM document_processing_batches b
  WHERE b.status IN ('completed', 'completed_with_failures', 'failed')
    AND b.classification_triggered = true
    AND b.updated_at < now() - p_grace
    AND b.stage3_failure_count = 0
    AND b.stage6_failure_count = 0
    AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id)
    AND NOT EXISTS (SELECT 1 FROM estimate_runs er WHERE er.batch_id = b.id AND er.builder_status IS NOT NULL)
    AND NOT EXISTS (
      SELECT 1 FROM document_processing_jobs j
      JOIN files f ON f.id = j.document_id
      WHERE j.parent_job_id = b.id
        AND f.ai_failure_count > 0
        AND NOT EXISTS (
          SELECT 1 FROM project_documents pd
          WHERE pd.file_id = f.id AND pd.extraction_status = 'complete'
        )
    )
  ORDER BY b.updated_at ASC;
$function$;

COMMENT ON FUNCTION find_stuck_batches_needing_classification_retry IS
  'Finds batches whose classification finished but Stage 3/6 was never (re-)triggered, or which stalled mid-stage and are past their grace period. As of migration 104, orders results oldest-stalled-first (b.updated_at ASC) so the caller''s per-tick cap (MAX_STUCK_FILES_PER_RUN, route.ts) drains a backlog fairly instead of an unordered scan risking starvation of newer batches. Called from GET /api/cron/intake-recovery step 5.';

NOTIFY pgrst, 'reload schema';
