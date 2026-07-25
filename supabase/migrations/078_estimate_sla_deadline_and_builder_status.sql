-- 078_estimate_sla_deadline_and_builder_status.sql
-- WorkA Product Reliability Requirement: 15-Minute Estimate Guarantee.
-- Reliability/UX layer only — no change to pricing, document extraction, or
-- Stage 1/2/3/6 estimation logic. Builds entirely on the existing
-- estimate_runs projection (migration 056-058) and the Stage 3/6 failure
-- escalation + total_ai_call_attempts ceiling added this session (migration
-- 077) — this migration adds the missing TIME dimension on top of the
-- already-bounded AI-CALL-COUNT dimension.
--
-- Builder-facing outcome model (distinct from estimate_runs.status, which
-- stays the internal pipeline-stage projection): every run must reach
-- exactly one of:
--   ESTIMATE_READY               — complete, no missing trades, no
--                                   unresolved conservative assumptions
--   ESTIMATE_READY_WITH_WARNINGS — a real quote with real line items
--                                   exists, but something is incomplete
--                                   (missing trade, unconfirmed assumption,
--                                   or the 15-minute deadline was hit before
--                                   full completion)
--   NEEDS_REVIEW                 — no usable quote/line items exist at all;
--                                   automated estimation stopped
-- NULL means still genuinely in progress, within its window — never a
-- fourth silent state.

ALTER TABLE estimate_runs
  ADD COLUMN IF NOT EXISTS deadline_at timestamptz,
  ADD COLUMN IF NOT EXISTS builder_status text
    CHECK (builder_status IN ('ESTIMATE_READY', 'ESTIMATE_READY_WITH_WARNINGS', 'NEEDS_REVIEW')),
  ADD COLUMN IF NOT EXISTS needs_review_reason text;

-- Backfill existing rows so the deadline concept is never NULL for a
-- pre-existing run (set from started_at, matching how a fresh row will get
-- it going forward — see reconcile_estimate_run below).
UPDATE estimate_runs SET deadline_at = started_at + interval '15 minutes' WHERE deadline_at IS NULL;

COMMENT ON COLUMN estimate_runs.deadline_at IS
  'started_at + 15 minutes, set once at row creation and never modified afterward (see reconcile_estimate_run''s ON CONFLICT clause) — the SLA window''s hard boundary. Compared against by enforce_estimate_deadlines() and by the recovery cron before retriggering any batch.';
COMMENT ON COLUMN estimate_runs.builder_status IS
  'The one builder-facing outcome: ESTIMATE_READY / ESTIMATE_READY_WITH_WARNINGS / NEEDS_REVIEW, or NULL while still genuinely in progress within the SLA window. Set once, either by reconcile_estimate_run when the pipeline reaches complete/failed on its own, or by enforce_estimate_deadlines() if the 15-minute deadline passes first. Never reset once set (same COALESCE-once semantics as completed_at).';
COMMENT ON COLUMN estimate_runs.needs_review_reason IS
  'Human-readable explanation for builder_status, always populated whenever builder_status is. The one thing a builder returning after 15 minutes should be able to read and understand immediately.';

-- ── compute_builder_status: the one place that decides the outcome ─────────
-- Reuses the EXACT same signals lib/estimating/readiness.ts's send gate
-- already uses (missing trades via scope_items/quote_line_items, unresolved
-- conservative assumptions via assumptions.gate IS NULL) — no new business
-- logic invented, this is an SQL-side mirror for observability/finalization
-- purposes only. It does NOT gate sending — getSendBlockingReasons remains
-- the sole send-time authority, untouched by this migration.
CREATE OR REPLACE FUNCTION compute_builder_status(p_batch_id uuid)
RETURNS TABLE(builder_status text, reason text) AS $$
DECLARE
  v_batch document_processing_batches%ROWTYPE;
  v_line_item_count int;
  v_missing_trade_count int;
  v_unresolved_conservative int;
BEGIN
  SELECT * INTO v_batch FROM document_processing_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NEEDS_REVIEW'::text, 'Batch record not found.'::text;
    RETURN;
  END IF;

  IF v_batch.quote_id IS NULL THEN
    RETURN QUERY SELECT 'NEEDS_REVIEW'::text,
      COALESCE(
        (SELECT f.failure_reason FROM files f WHERE f.processing_batch_id = p_batch_id AND f.failure_reason IS NOT NULL ORDER BY f.id LIMIT 1),
        'No estimate could be generated in the time available. Automated estimation stopped before producing any priced line items.'
      );
    RETURN;
  END IF;

  SELECT count(*) INTO v_line_item_count
  FROM quote_line_items
  WHERE quote_id = v_batch.quote_id AND assumption_status IS DISTINCT FROM 'excluded';

  IF v_line_item_count = 0 THEN
    RETURN QUERY SELECT 'NEEDS_REVIEW'::text, 'A quote record was created but no usable line items were generated.'::text;
    RETURN;
  END IF;

  SELECT count(*) INTO v_missing_trade_count
  FROM scope_items si
  WHERE si.job_id = v_batch.job_id
    AND array_length(si.included_scope, 1) > 0
    AND NOT EXISTS (
      SELECT 1 FROM quote_line_items li
      WHERE li.quote_id = v_batch.quote_id
        AND li.trade_category_id = si.trade_category_id
        AND li.assumption_status IS DISTINCT FROM 'excluded'
    );

  SELECT count(*) INTO v_unresolved_conservative
  FROM assumptions
  WHERE quote_id = v_batch.quote_id AND gate IS NULL AND line_item_id IS NULL AND resolution_type IS NULL;

  IF v_missing_trade_count > 0 OR v_unresolved_conservative > 0 THEN
    RETURN QUERY SELECT 'ESTIMATE_READY_WITH_WARNINGS'::text,
      format(
        'Preliminary estimate generated (%s line item(s)). %s scoped trade(s) missing line items, %s assumption(s) need confirmation — review before sending.',
        v_line_item_count, v_missing_trade_count, v_unresolved_conservative
      );
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ESTIMATE_READY'::text, format('Estimate complete — %s line items.', v_line_item_count);
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION compute_builder_status IS
  'Derives the builder-facing outcome (ESTIMATE_READY / ESTIMATE_READY_WITH_WARNINGS / NEEDS_REVIEW) and a human-readable reason for a batch, from whatever quote/line-item/scope/assumption state already exists — never generates or modifies anything, purely reads existing pricing/estimation output. Reuses the same missing-trade and unresolved-conservative-assumption definitions as lib/estimating/readiness.ts''s send gate.';

-- ── reconcile_estimate_run: set deadline_at once, finalize builder_status
-- once the pipeline reaches complete/failed on its own (before any deadline
-- watchdog needs to act) ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION reconcile_estimate_run(p_batch_id uuid)
RETURNS uuid AS $$
DECLARE
  v_batch    document_processing_batches%ROWTYPE;
  v_proj     estimate_run_projection;
  v_run_id   uuid;
  v_prev_status text;
  v_builder_status text;
  v_reason text;
BEGIN
  SELECT * INTO v_batch FROM document_processing_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  v_proj := derive_estimate_run_projection(p_batch_id);

  SELECT status INTO v_prev_status FROM estimate_runs WHERE batch_id = p_batch_id;

  IF v_proj.status IN ('complete', 'failed') THEN
    SELECT cbs.builder_status, cbs.reason INTO v_builder_status, v_reason FROM compute_builder_status(p_batch_id) cbs;
  END IF;

  INSERT INTO estimate_runs AS er (
    job_id, builder_id, batch_id, status, quote_id,
    documents_total, documents_processed, documents_failed,
    blocking_questions_open, lock_held, stall_reason, failure_reason,
    last_progress_at, completed_at, reconciled_at,
    deadline_at, builder_status, needs_review_reason
  ) VALUES (
    v_batch.job_id, v_batch.builder_id, p_batch_id, v_proj.status, v_proj.quote_id,
    v_proj.documents_total, v_proj.documents_processed, v_proj.documents_failed,
    v_proj.blocking_questions_open, v_proj.lock_held, v_proj.stall_reason, v_proj.failure_reason,
    v_proj.last_progress_at,
    CASE WHEN v_proj.status IN ('complete', 'failed') THEN now() ELSE NULL END,
    now(),
    now() + interval '15 minutes',
    v_builder_status, v_reason
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
    needs_review_reason = COALESCE(er.needs_review_reason, EXCLUDED.needs_review_reason)
  RETURNING er.id INTO v_run_id;

  IF v_prev_status IS DISTINCT FROM v_proj.status THEN
    INSERT INTO estimate_run_events (estimate_run_id, from_status, to_status, detail)
    VALUES (v_run_id, v_prev_status, v_proj.status, jsonb_build_object(
      'documents_total', v_proj.documents_total, 'documents_processed', v_proj.documents_processed,
      'documents_failed', v_proj.documents_failed, 'builder_status', v_builder_status
    ));
  END IF;

  RETURN v_run_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reconcile_estimate_run IS
  'Derives and upserts one batch''s estimate_runs projection row, same as migration 057, plus (migration 078): sets deadline_at once at creation (started_at + 15 minutes, never modified again) and finalizes builder_status/needs_review_reason via compute_builder_status the moment the pipeline reaches complete/failed on its own — before any deadline watchdog would ever need to act. A run that finishes within its window never waits on enforce_estimate_deadlines().';

-- ── enforce_estimate_deadlines: the watchdog ────────────────────────────────
-- Finds runs whose 15-minute window has passed with no outcome decided yet,
-- and finalizes them using whatever quote/line-item state already exists —
-- generates nothing new, just stops waiting and reports the best available
-- outcome. FOR UPDATE SKIP LOCKED: safe to call from multiple concurrent
-- cron ticks without double-finalizing the same run.
CREATE OR REPLACE FUNCTION enforce_estimate_deadlines()
RETURNS TABLE(estimate_run_id uuid, job_id uuid, batch_id uuid, builder_status text, reason text) AS $$
DECLARE
  r record;
  v_status text;
  v_reason text;
BEGIN
  FOR r IN
    SELECT er.id, er.job_id, er.batch_id, er.status
    FROM estimate_runs er
    WHERE er.deadline_at < now()
      AND er.builder_status IS NULL
    FOR UPDATE SKIP LOCKED
  LOOP
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
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enforce_estimate_deadlines IS
  'The 15-minute SLA watchdog. Finds every estimate_runs row whose deadline_at has passed with builder_status still NULL (genuinely undecided) and finalizes it via compute_builder_status — using only whatever quote/line-item state already exists, never generating anything new. This is what guarantees a builder returning after 15 minutes always finds ESTIMATE_READY, ESTIMATE_READY_WITH_WARNINGS, or NEEDS_REVIEW, never silence. Called from GET /api/cron/intake-recovery on every tick, independent of DOCUMENT_RECOVERY_DISABLED/AI_RECOVERY_DISABLED (finalizing a status makes no Anthropic call and triggers no worker).';

-- ── Recovery eligibility: a finalized run must never be retriggered ────────
-- "Is this incomplete AND still eligible for recovery" — eligibility now
-- requires builder_status still being NULL (undecided), on top of the
-- existing per-file/per-batch retry-attempt caps. Once enforce_estimate_
-- deadlines (or a natural completion) sets builder_status, the outcome is
-- final and no further automatic retry may occur — matching the explicit
-- product requirement that recovery must ask both questions, not just one.
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
    AND NOT EXISTS (SELECT 1 FROM estimate_runs er WHERE er.batch_id = b.id AND er.builder_status IS NOT NULL);
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION find_stuck_batches_needing_classification_retry IS
  'Batches whose document-processing finished and flipped classification_triggered, but no job_intake_locks row ever appeared for the job. Excludes any batch with stage3_failure_count > 0 OR stage6_failure_count > 0 (migration 077) and, as of migration 078, any batch whose estimate_runs row already has a finalized builder_status — a run the 15-minute SLA watchdog (or a natural completion) has already decided an outcome for must never be retried again, regardless of what any other counter says.';

CREATE OR REPLACE FUNCTION find_batches_with_claimable_work()
RETURNS TABLE(parent_job_id uuid, job_id uuid, builder_id uuid, pending_count bigint) AS $$
  SELECT b.id, b.job_id, b.builder_id, count(j.id)
  FROM document_processing_batches b
  JOIN document_processing_jobs j ON j.parent_job_id = b.id
  WHERE b.status IN ('pending', 'running')
    AND j.status = 'pending'
    AND j.run_after <= now()
    AND NOT EXISTS (
      SELECT 1 FROM files f
      WHERE f.id = j.document_id
        AND f.intake_status = 'failed'
        AND f.failure_stage = 'ABANDONED'
    )
    AND NOT EXISTS (SELECT 1 FROM estimate_runs er WHERE er.batch_id = b.id AND er.builder_status IS NOT NULL)
  GROUP BY b.id, b.job_id, b.builder_id;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION find_batches_with_claimable_work IS
  'Batches with at least one claimable (pending, run_after due) document_processing_jobs row. Excludes files already marked abandoned (migration 075) and, as of migration 078, any batch whose estimate_runs row already has a finalized builder_status — a run the SLA watchdog already closed out must never resume, even for the zero-Anthropic-cost document-extraction path.';

-- ── Monitoring: the metrics this requirement asks to track ──────────────────
CREATE OR REPLACE FUNCTION estimate_reliability_summary(p_since interval DEFAULT interval '7 days')
RETURNS TABLE(
  total_runs bigint,
  completed_runs bigint,
  avg_upload_to_estimate_seconds numeric,
  pct_under_15_min numeric,
  needs_review_count bigint,
  estimate_ready_count bigint,
  estimate_ready_with_warnings_count bigint,
  still_in_progress_count bigint,
  avg_ai_cost_cents_per_estimate numeric,
  abandoned_count bigint
) AS $$
  WITH runs AS (
    SELECT er.*,
      extract(epoch FROM (er.completed_at - er.started_at)) AS duration_seconds
    FROM estimate_runs er
    WHERE er.started_at > now() - p_since
  ),
  cost_per_job AS (
    SELECT split_part(ao.scope_key, ':', 1)::uuid AS job_id, sum(ao.cost_cents) AS total_cost_cents
    FROM ai_operations ao
    WHERE ao.scope_key IS NOT NULL AND ao.created_at > now() - p_since
    GROUP BY 1
  )
  SELECT
    count(*),
    count(*) FILTER (WHERE completed_at IS NOT NULL),
    round(avg(duration_seconds) FILTER (WHERE completed_at IS NOT NULL), 1),
    round(
      100.0 * count(*) FILTER (WHERE completed_at IS NOT NULL AND duration_seconds <= 900)
      / NULLIF(count(*) FILTER (WHERE completed_at IS NOT NULL), 0),
      1
    ),
    count(*) FILTER (WHERE builder_status = 'NEEDS_REVIEW'),
    count(*) FILTER (WHERE builder_status = 'ESTIMATE_READY'),
    count(*) FILTER (WHERE builder_status = 'ESTIMATE_READY_WITH_WARNINGS'),
    count(*) FILTER (WHERE builder_status IS NULL),
    round(avg(cpj.total_cost_cents), 1),
    -- "Abandoned" here means: finalized NEEDS_REVIEW with nothing ever
    -- generated at all (no quote) — the specific outcome this requirement
    -- treats as the failure mode to minimize, distinct from a builder simply
    -- not having returned to review a WITH_WARNINGS estimate yet (not
    -- observable from this table).
    count(*) FILTER (WHERE builder_status = 'NEEDS_REVIEW' AND quote_id IS NULL)
  FROM runs
  LEFT JOIN cost_per_job cpj ON cpj.job_id = runs.job_id;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION estimate_reliability_summary IS
  'Rollup for the 15-minute estimate guarantee: total/completed runs, average upload-to-estimate duration, percentage completed within 15 minutes (the >=95% target), counts by builder_status, average AI cost per estimate (joined from ai_operations via scope_key), and abandoned estimates (NEEDS_REVIEW with no quote generated at all). p_since bounds the window (default 7 days) so this stays cheap to call on a dashboard.';

NOTIFY pgrst, 'reload schema';
