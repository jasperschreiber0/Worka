-- ============================================================
-- WorkA — exclude Stage 1/2-failed batches from classification retry
-- ============================================================
-- Root cause of the 60ea9c63-96ba-40b5-be2c-37c01fb33f01 incident: Stage 3
-- (stage3_failure_count) and Stage 6 (stage6_failure_count) both have a
-- batch-level failure counter that find_stuck_batches_needing_classification_
-- retry (migration 052/078) excludes on -- "a non-zero count proves
-- Anthropic WAS reached and the failure is real and deterministic, not a
-- lost fetch". Stage 1/2 has NO batch-level equivalent: its own failure
-- signal, files.ai_failure_count/ai_failure_classification (migration 042),
-- lives on `files`, a table this query never joins. A batch whose only
-- document repeatedly fails Stage 1/2 classification (confirmed here: the
-- ceiling-exceeded/budget_refused error thrown by callTool before Stage 1/2
-- ever reaches Anthropic, or a genuine Stage 1/2 Anthropic failure) never
-- accumulates stage3_failure_count or stage6_failure_count (Stage 3/6 are
-- never reached), so this query kept matching it forever: reclaim lock,
-- retrigger smooth-responder, fail again, repeat every cron tick
-- indefinitely -- each retrigger a real (attempted) Anthropic call, which is
-- what drove document_processing_batches.total_ai_call_attempts past the
-- 20-call ceiling and tripped the GLOBAL system_status.ai_circuit_breaker,
-- blocking every builder's AI calls platform-wide (confirmed live: /api/chat
-- extractActions calls started failing with AiBudgetError).
--
-- Fix: extend the same exclusion with the SAME "any document tied to this
-- batch already has non-zero ai_failure_count" check Stage 3/6 already use
-- at the batch level -- no new schema, reuses files.ai_failure_count exactly
-- as record_ai_failure (migration 043) already writes it. A batch is
-- excluded the moment ANY of its documents has recorded even one genuine
-- Stage 1/2 AI failure, matching Stage 3/6's own unconditional (not
-- classification/count-threshold-gated) exclusion precedent -- retrying a
-- failed-Anthropic-call is Stage 1/2's OWN escalation logic's job
-- (files.ai_failure_count + maxConsecutiveOccurrences pre-request guards,
-- already wired into splitIntoBatches' batch planning), never this generic
-- cron path's job, exactly like Stage 3/6.
--
-- A batch that never reached Stage 1/2 (files.ai_failure_count = 0 for
-- every document — e.g. the classification_triggered fetch was simply lost)
-- is completely unaffected and still retried exactly as before.
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
      WHERE j.parent_job_id = b.id AND f.ai_failure_count > 0
    );
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION find_stuck_batches_needing_classification_retry IS
  'Batches whose document-processing finished and flipped classification_triggered, but no job_intake_locks row ever appeared for the job. Excludes any batch with stage3_failure_count > 0 OR stage6_failure_count > 0 (migration 077), any batch whose estimate_runs row already has a finalized builder_status (migration 078), and, as of migration 088, any batch with a document whose files.ai_failure_count > 0 (migration 042/043) -- the Stage 1/2 equivalent of the stage3/stage6 exclusions, closing the gap that let a batch failing during classification (never reaching Stage 3/6) retrigger this generic cron path forever and repeatedly trip the global AI circuit breaker.';
