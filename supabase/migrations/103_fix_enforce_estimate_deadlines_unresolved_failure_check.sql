-- ============================================================
-- WorkA — enforce_estimate_deadlines(): apply migration 102's corrected
-- eligibility semantics to the deadline-extension branch
-- ============================================================
-- Confirmed live (read-only investigation, this session): enforce_estimate_
-- deadlines()'s extension-eligibility check (migration 089) is a second,
-- independent copy of the same ai_failure_count>0 predicate migration 102
-- already fixed in find_stuck_batches_needing_classification_retry() --
-- byte-identical to the pre-102 version, confirmed via pg_get_functiondef.
-- Migration 102 fixed one of the two copies and left this one untouched.
--
-- Effect: a batch whose only failing document has SINCE durably completed
-- Stage 1/2 (project_documents.extraction_status='complete') is denied its
-- bounded +6min/x3 extension and immediately finalized NEEDS_REVIEW, even
-- though every other extension-eligibility condition is satisfied. Confirmed
-- on job 1f12de7f-47b5-442e-9581-1f813796eb70: batch ac0380e4-b74b-46f0-
-- ab9e-e42de35e71c8 reached extraction_status='complete' for its one
-- document at 04:54:28, yet was finalized NEEDS_REVIEW at 05:13:00 solely
-- because this copy's NOT EXISTS clause had no extraction_status exemption.
--
-- Fix: identical, minimal change to the identical clause -- add the same
-- "unless the document has since reached extraction_status='complete'"
-- exemption migration 102 already added and already proved correct (a
-- synthetic regression test plus a real production replay). Nothing else
-- in this function changes: the 15-minute SLA, the +6 minute extension
-- amount, the 3-extension cap, the finalize-once builder_status invariant,
-- and every other extension-eligibility condition (terminal status,
-- classification_triggered, stage3/6 failure counts, job_intake_locks,
-- quote_id IS NULL) are untouched. A document whose Stage 1/2 is still
-- genuinely unresolved (ai_failure_count>0, no completed extraction_status
-- row) continues to deny the extension exactly as before.
CREATE OR REPLACE FUNCTION enforce_estimate_deadlines()
RETURNS TABLE(estimate_run_id uuid, job_id uuid, batch_id uuid, builder_status text, reason text) AS $$
DECLARE
  r record;
  v_status text;
  v_reason text;
  v_extended boolean;
  v_max_extensions constant integer := 3;
  v_extension constant interval := interval '6 minutes';
BEGIN
  FOR r IN
    SELECT er.id, er.job_id, er.batch_id, er.status, er.deadline_extensions_used
    FROM estimate_runs er
    WHERE er.deadline_at < now()
      AND er.builder_status IS NULL
    FOR UPDATE SKIP LOCKED
  LOOP
    v_extended := false;

    -- Is this batch still a live, bounded, automatic-recovery candidate?
    -- Same predicate find_stuck_batches_needing_classification_retry uses
    -- (minus its own updated_at grace window, irrelevant here -- we only
    -- care whether the batch is STRUCTURALLY eligible, not whether the
    -- retry cron's own grace period has elapsed yet) plus quote_id IS
    -- NULL, so a batch that already has a persisted result is always
    -- finalized immediately rather than pointlessly extended. As of
    -- migration 103, the ai_failure_count check carries the SAME
    -- extraction_status='complete' exemption migration 102 already
    -- added to the other copy of this predicate -- a document that
    -- failed once but has since durably completed Stage 1/2 no longer
    -- counts as "still broken" here either.
    IF r.deadline_extensions_used < v_max_extensions AND EXISTS (
      SELECT 1
      FROM document_processing_batches b
      WHERE b.id = r.batch_id
        AND b.quote_id IS NULL
        AND b.status IN ('completed', 'completed_with_failures', 'failed')
        AND b.classification_triggered = true
        AND b.stage3_failure_count = 0
        AND b.stage6_failure_count = 0
        AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id)
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
    ) THEN
      UPDATE estimate_runs
      SET deadline_at = now() + v_extension,
          deadline_extensions_used = deadline_extensions_used + 1
      WHERE id = r.id;

      INSERT INTO estimate_run_events (estimate_run_id, from_status, to_status, detail)
      VALUES (r.id, r.status, r.status, jsonb_build_object(
        'event', 'deadline_extended_pending_recovery',
        'extensions_used', r.deadline_extensions_used + 1,
        'max_extensions', v_max_extensions
      ));

      v_extended := true;
    END IF;

    IF NOT v_extended THEN
      SELECT cbs.builder_status, cbs.reason INTO v_status, v_reason FROM compute_builder_status(r.batch_id) cbs;
      v_reason := format('15-minute processing window exceeded (was in stage: %s). %s', r.status, v_reason);

      UPDATE estimate_runs
      SET builder_status = v_status,
          needs_review_reason = v_reason,
          completed_at = COALESCE(completed_at, now())
      WHERE id = r.id;

      INSERT INTO estimate_run_events (estimate_run_id, from_status, to_status, detail)
      VALUES (r.id, r.status, r.status, jsonb_build_object(
        'event', 'deadline_enforced', 'builder_status', v_status, 'reason', v_reason
      ));

      estimate_run_id := r.id; job_id := r.job_id; batch_id := r.batch_id;
      builder_status := v_status; reason := v_reason;
      RETURN NEXT;
    END IF;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enforce_estimate_deadlines IS
  'The 15-minute SLA watchdog. Finds every estimate_runs row whose deadline_at has passed with builder_status still NULL. A batch that is still a live, bounded, classification-retry-eligible candidate (migration 089) gets deadline_at pushed forward (bounded to 3 extensions of 6 minutes each) instead of being finalized. As of migration 103, that eligibility check carries the same extraction_status=''complete'' exemption migration 102 added to find_stuck_batches_needing_classification_retry() -- a document that failed Stage 1/2 once but has since durably completed it no longer denies the extension; a document still genuinely unresolved still does. Every other batch (extensions exhausted, or never retry-eligible to begin with) is finalized exactly as before via compute_builder_status. builder_status remains permanently terminal once set -- no reopening mechanism. Called from GET /api/cron/intake-recovery on every tick, independent of DOCUMENT_RECOVERY_DISABLED/AI_RECOVERY_DISABLED.';
