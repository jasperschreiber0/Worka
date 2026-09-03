-- ============================================================
-- WorkA — find_stuck_batches_needing_classification_retry: exclude only
-- UNRESOLVED Stage 1/2 failures, not every historical one
-- ============================================================
-- Root cause, found live on job 1f12de7f-47b5-442e-9581-1f813796eb70
-- immediately after the Stage 1/2 truncation-recovery fix (commit
-- f9b0233) started working: migration 088 added an exclusion for any
-- batch with a document whose files.ai_failure_count > 0, to stop a
-- batch that fails Stage 1/2 forever from retriggering this cron path
-- (and burning real Anthropic calls) every tick indefinitely. But
-- files.ai_failure_count is written only by record_ai_failure on
-- FAILURE (migration 043) and is NEVER reset on a later success — it is,
-- and must remain, historical telemetry (see maxConsecutiveOccurrences'
-- own comment in pipeline-logic.ts). A document that fails Stage 1/2
-- once and then genuinely succeeds on a later attempt (exactly what the
-- new truncation-recovery mechanism enables — see CLAUDE.md's
-- "Anthropic failure classification" section) keeps ai_failure_count=1
-- forever, so migration 088's unconditional check permanently excludes
-- its batch from ever being auto-resumed again, even though Stage 1/2
-- has already durably completed for it.
--
-- Confirmed live: the target file (f2b240fb-5be7-4931-b795-4d140c1c7e63)
-- completed Stage 1/2 successfully at 2026-09-03T04:50:47Z
-- (stop_reason='tool_use', 97 project_facts persisted, project_documents
-- extraction_status='complete'), yet 4 consecutive autonomous pg_cron
-- ticks (05:09, 05:10, 05:11, 05:12) each reported zero recovery action,
-- and a direct call to find_stuck_batches_needing_classification_retry()
-- confirmed the batch absent from its result set — every OTHER exclusion
-- clause (status, classification_triggered, grace period, stage3/6
-- failure counts, job_intake_locks, estimate_runs finalized status) was
-- satisfied; only the ai_failure_count join excluded it.
--
-- Fix: the ai_failure_count join now additionally requires that the
-- document does NOT already have a project_documents row with
-- extraction_status='complete' (migration 050) — the one atomic,
-- authoritative signal that Stage 1/2 genuinely succeeded for that
-- document, written once by persist_document_classification alongside
-- its project_facts, and never set by any failure path. A document whose
-- Stage 1/2 is still genuinely unresolved (ai_failure_count > 0, no
-- complete row) continues to exclude its batch exactly as migration 088
-- already did — this closes the gap for RECOVERED documents only, and
-- cannot resurrect a still/permanently-failed document, since such a
-- document can never structurally acquire extraction_status='complete'
-- without a real successful classification having actually happened.
-- ai_failure_count/ai_failure_classification themselves are untouched by
-- this migration — no reset, no write — they remain exactly the
-- historical telemetry they already were.
CREATE OR REPLACE FUNCTION find_stuck_batches_needing_classification_retry(p_grace interval DEFAULT interval '3 minutes')
RETURNS TABLE(batch_id uuid, job_id uuid, builder_id uuid, primary_file_id uuid) AS $$
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
    );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION find_stuck_batches_needing_classification_retry IS
  'Batches whose document-processing finished and flipped classification_triggered, but no job_intake_locks row ever appeared for the job. Excludes any batch with stage3_failure_count > 0 OR stage6_failure_count > 0 (migration 077), any batch whose estimate_runs row already has a finalized builder_status (migration 078), and any batch with a document whose files.ai_failure_count > 0 AND that document has NOT since durably completed Stage 1/2 (no project_documents row with extraction_status=''complete'', migration 102 — narrowed from migration 088''s unconditional ai_failure_count > 0 check, which permanently excluded a batch even after its only failing document later genuinely recovered, since ai_failure_count is historical telemetry and is never reset on success).';
