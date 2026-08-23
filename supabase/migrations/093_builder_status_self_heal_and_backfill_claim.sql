-- ── 093: repair frozen false-positive builder_status, and give the pricing/
--         QA backfill sweep the same claim+cap discipline every other
--         retry mechanism in this pipeline already has ─────────────────────
--
-- Two independent fixes, from the same reliability review as migrations
-- 091/092:
--
-- 1. estimate_runs.builder_status self-heal (audit finding §3.2/§2D).
--    reconcile_estimate_run's own upsert uses
--    `builder_status = COALESCE(er.builder_status, EXCLUDED.builder_status)`
--    -- correct as a general "don't let a later stale recompute overwrite an
--    already-decided outcome" rule, but it means any estimate_runs row
--    whose builder_status was incorrectly set to ESTIMATE_READY/
--    ESTIMATE_READY_WITH_WARNINGS *before* migration 092 existed (i.e.
--    before compute_builder_status checked pricing/QA completion) is frozen
--    that way forever -- migration 092 prevents this from happening to any
--    NEW row, but cannot retroactively repair one already set wrong. Fixed
--    by clearing (not fabricating a new value for) exactly that provably-
--    wrong case at the top of reconcile_estimate_run, before the upsert:
--    if the stored builder_status claims readiness but the quote it points
--    to genuinely has no total_cost or no qa_report, null the stored value
--    out so the fresh compute_builder_status call a few lines below is
--    free to set the correct one. This only ever moves a row from
--    "wrongly claims ready" to "will be correctly recomputed" -- it never
--    invents a value, never touches a correctly-set row, and never touches
--    a NEEDS_REVIEW row (already the conservative, safe answer).
--
-- 2. Pricing/QA backfill sweep claim + attempt cap (audit findings §3.3/
--    §3.4). The sweep added in migration 092 (app/api/cron/intake-recovery/
--    route.ts) had no per-quote attempt cap (every other retry mechanism in
--    this pipeline has one -- MAX_RECOVERY_ATTEMPTS, maxConsecutiveOccurrences,
--    retry_or_fail_document_job's 3-attempt cap) and no protection against
--    two concurrent recovery-cron invocations both picking the same quote.
--    claim_quote_for_pricing_qa_backfill mirrors claim_next_document_job's
--    own FOR UPDATE row-lock pattern (migration 034) and
--    record_intake_recovery_attempt's atomic attempt-counting pattern
--    (migration 051): one atomic claim per quote, capped at 3 attempts
--    (matching MAX_RECOVERY_ATTEMPTS elsewhere), with a 3-minute staleness
--    window so a claim left by a crashed/killed invocation doesn't block
--    that quote forever.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS pricing_qa_backfill_attempts integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pricing_qa_backfill_claimed_at timestamptz;

COMMENT ON COLUMN quotes.pricing_qa_backfill_attempts IS
  'How many times GET /api/cron/intake-recovery''s pricing/QA backfill sweep has attempted this quote. Capped (see claim_quote_for_pricing_qa_backfill) to stop an unrecoverable pricing/QA bug from retrying the same quote forever.';
COMMENT ON COLUMN quotes.pricing_qa_backfill_claimed_at IS
  'Set by claim_quote_for_pricing_qa_backfill when a recovery-cron run claims this quote for pricing/QA backfill -- the same run-then-release pattern job_intake_locks uses, scoped to one quote instead of one job. A claim older than 3 minutes is considered abandoned and reclaimable.';

CREATE OR REPLACE FUNCTION claim_quote_for_pricing_qa_backfill(
  p_quote_id uuid,
  p_max_attempts integer DEFAULT 3,
  p_stale_after interval DEFAULT interval '3 minutes'
)
RETURNS TABLE(claimed boolean, capped boolean, attempts integer) AS $$
DECLARE
  v_row quotes%ROWTYPE;
BEGIN
  SELECT * INTO v_row FROM quotes WHERE id = p_quote_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN QUERY SELECT false, false, 0;
    RETURN;
  END IF;

  IF v_row.pricing_qa_backfill_attempts >= p_max_attempts THEN
    RETURN QUERY SELECT false, true, v_row.pricing_qa_backfill_attempts;
    RETURN;
  END IF;

  -- Held by a concurrent (or still genuinely running) claim, not yet stale.
  IF v_row.pricing_qa_backfill_claimed_at IS NOT NULL
     AND v_row.pricing_qa_backfill_claimed_at > now() - p_stale_after THEN
    RETURN QUERY SELECT false, false, v_row.pricing_qa_backfill_attempts;
    RETURN;
  END IF;

  UPDATE quotes
  SET pricing_qa_backfill_attempts = pricing_qa_backfill_attempts + 1,
      pricing_qa_backfill_claimed_at = now()
  WHERE id = p_quote_id;

  RETURN QUERY SELECT true, false, v_row.pricing_qa_backfill_attempts + 1;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION claim_quote_for_pricing_qa_backfill IS
  'Atomic claim (FOR UPDATE row lock, same idiom as claim_next_document_job) for the pricing/QA backfill sweep in GET /api/cron/intake-recovery. Returns claimed=false either because another run holds a non-stale claim (capped=false) or because the attempt cap was reached (capped=true) -- the caller should stop retrying that quote once capped=true, logging it rather than silently looping forever.';

CREATE OR REPLACE FUNCTION reconcile_estimate_run(p_batch_id uuid)
RETURNS uuid AS $$
DECLARE
  v_batch    document_processing_batches%ROWTYPE;
  v_proj     estimate_run_projection;
  v_run_id   uuid;
  v_prev_status text;
  v_builder_status text;
  v_reason text;
  v_reason_code text;
  v_coverage estimate_document_coverage;
  v_cbs record;
BEGIN
  SELECT * INTO v_batch FROM document_processing_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  -- Self-heal (migration 093): a builder_status already claiming readiness
  -- for a quote that provably has no pricing or no QA yet was set wrong,
  -- most likely before migration 092 existed. Clearing it here -- and
  -- ONLY here, and ONLY for this exact provably-wrong case -- lets the
  -- fresh compute_builder_status call below correctly recompute it. Never
  -- touches a row already correctly NEEDS_REVIEW, never fabricates a value.
  UPDATE estimate_runs er
  SET builder_status = NULL, needs_review_reason = NULL, needs_review_reason_code = NULL
  WHERE er.batch_id = p_batch_id
    AND er.builder_status IN ('ESTIMATE_READY', 'ESTIMATE_READY_WITH_WARNINGS')
    AND EXISTS (
      SELECT 1 FROM document_processing_batches b
      JOIN quotes q ON q.id = b.quote_id
      WHERE b.id = p_batch_id AND (q.total_cost IS NULL OR q.qa_report IS NULL)
    );

  v_proj := derive_estimate_run_projection(p_batch_id);

  SELECT status INTO v_prev_status FROM estimate_runs WHERE batch_id = p_batch_id;

  IF v_proj.status IN ('complete', 'failed') THEN
    SELECT * INTO v_cbs FROM compute_builder_status(p_batch_id) cbs;
    v_builder_status := v_cbs.builder_status;
    v_reason := v_cbs.reason;
    v_reason_code := v_cbs.reason_code;
    v_coverage := v_cbs.coverage;
  END IF;

  INSERT INTO estimate_runs AS er (
    job_id, builder_id, batch_id, status, quote_id,
    documents_total, documents_processed, documents_failed,
    blocking_questions_open, lock_held, stall_reason, failure_reason,
    last_progress_at, completed_at, reconciled_at,
    deadline_at, builder_status, needs_review_reason, needs_review_reason_code,
    coverage_documents_uploaded, coverage_documents_analyzed, coverage_percentage,
    confidence_level, contributing_documents, missing_documents
  ) VALUES (
    v_batch.job_id, v_batch.builder_id, p_batch_id, v_proj.status, v_proj.quote_id,
    v_proj.documents_total, v_proj.documents_processed, v_proj.documents_failed,
    v_proj.blocking_questions_open, v_proj.lock_held, v_proj.stall_reason, v_proj.failure_reason,
    v_proj.last_progress_at,
    CASE WHEN v_proj.status IN ('complete', 'failed') THEN now() ELSE NULL END,
    now(),
    now() + interval '15 minutes',
    v_builder_status, v_reason, v_reason_code,
    (v_coverage).documents_uploaded, (v_coverage).documents_analyzed, (v_coverage).coverage_percentage,
    (v_coverage).confidence_level, (v_coverage).contributing_documents, (v_coverage).missing_documents
  )
  ON CONFLICT (batch_id) DO UPDATE SET
    status = EXCLUDED.status,
    quote_id = EXCLUDED.quote_id,
    documents_total = EXCLUDED.documents_total,
    documents_processed = EXCLUDED.documents_processed,
    documents_failed = EXCLUDED.documents_failed,
    blocking_questions_open = EXCLUDED.blocking_questions_open,
    lock_held = EXCLUDED.lock_held,
    stall_reason = EXCLUDED.stall_reason,
    failure_reason = EXCLUDED.failure_reason,
    last_progress_at = EXCLUDED.last_progress_at,
    completed_at = COALESCE(er.completed_at, EXCLUDED.completed_at),
    reconciled_at = now(),
    -- deadline_at is deliberately NEVER updated here — set once at creation.
    builder_status = COALESCE(er.builder_status, EXCLUDED.builder_status),
    needs_review_reason = COALESCE(er.needs_review_reason, EXCLUDED.needs_review_reason),
    needs_review_reason_code = COALESCE(er.needs_review_reason_code, EXCLUDED.needs_review_reason_code),
    coverage_documents_uploaded = COALESCE(er.coverage_documents_uploaded, EXCLUDED.coverage_documents_uploaded),
    coverage_documents_analyzed = COALESCE(er.coverage_documents_analyzed, EXCLUDED.coverage_documents_analyzed),
    coverage_percentage = COALESCE(er.coverage_percentage, EXCLUDED.coverage_percentage),
    confidence_level = COALESCE(er.confidence_level, EXCLUDED.confidence_level),
    contributing_documents = COALESCE(er.contributing_documents, EXCLUDED.contributing_documents),
    missing_documents = COALESCE(er.missing_documents, EXCLUDED.missing_documents)
  RETURNING er.id INTO v_run_id;

  IF v_prev_status IS DISTINCT FROM v_proj.status THEN
    INSERT INTO estimate_run_events (estimate_run_id, from_status, to_status, detail)
    VALUES (v_run_id, v_prev_status, v_proj.status, jsonb_build_object(
      'documents_total', v_proj.documents_total, 'documents_processed', v_proj.documents_processed,
      'documents_failed', v_proj.documents_failed, 'builder_status', v_builder_status,
      'coverage_percentage', (v_coverage).coverage_percentage
    ));
  END IF;

  RETURN v_run_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reconcile_estimate_run IS
  'Derives and upserts one batch''s estimate_runs projection row. As of migration 093, self-heals a builder_status that was frozen claiming readiness before migration 092''s pricing/QA gate existed, by clearing it (never fabricating a replacement) whenever the quote it points to provably still lacks pricing or QA, so the fresh compute_builder_status call in the same invocation can correct it. Otherwise unchanged from migration 079: persists the compute_document_coverage snapshot and needs_review_reason_code alongside builder_status, using set-once/COALESCE semantics for everything computed only once a run reaches complete/failed.';

NOTIFY pgrst, 'reload schema';
