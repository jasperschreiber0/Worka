-- 079_estimate_document_coverage.sql
-- Product trust gap fix: the pipeline already tolerates partial document
-- processing (partial Stage 1/2 success, Stage 3 runs on whatever facts
-- exist, recovery is bounded — see migrations 034-078) but nothing ever
-- told the BUILDER how much of their upload actually made it into the
-- estimate. A 2-of-7-documents estimate and a 7-of-7 estimate rendered
-- identically in QuoteView. This is a status-calculation + metadata-
-- exposure change only — no extraction, Stage 3/6, pricing, or retry
-- logic is touched by this migration.
--
-- ── Where "coverage" actually comes from ────────────────────────────────
-- Three different "how much did we process" signals already exist in this
-- schema and answer three different questions:
--   document_processing_jobs.status = 'completed'  -> TEXT EXTRACTION done
--     (document-worker; migration 034). Says nothing about whether Claude
--     ever read/classified the document.
--   project_documents.extraction_status = 'complete' -> Stage 1/2
--     CLASSIFICATION done (migration 050, written atomically by
--     persist_document_classification). This is the real "did WorkA
--     actually analyse this document" signal, and what "coverage" below
--     is built on.
--   quotes.document_contribution -> per-document facts_used AT ESTIMATE
--     TIME (migration 039). Only exists once a quote has been built by
--     Stage 6, so it cannot answer "why does no estimate exist yet" — the
--     exact case this fix targets (2/7 documents, Stage 3 never reached).
-- compute_document_coverage below uses project_documents.extraction_status
-- joined against files.processing_batch_id, because it is the only one of
-- the three that is populated as soon as Stage 1/2 finishes for a
-- document, independent of whether Stage 6 ever runs.

-- ── Coverage metadata: a dedicated, reusable function ───────────────────
CREATE TYPE estimate_document_coverage AS (
  documents_uploaded            integer,
  documents_analyzed            integer,
  documents_failed_or_pending   integer,
  coverage_percentage           numeric,
  confidence_level              text,
  contributing_documents        jsonb,
  missing_documents             jsonb
);

CREATE OR REPLACE FUNCTION compute_document_coverage(p_batch_id uuid)
RETURNS estimate_document_coverage AS $$
DECLARE
  v_uploaded     integer;
  v_contributing jsonb;
  v_missing      jsonb;
  v_analyzed     integer;
  v_coverage_pct numeric;
  v_confidence   text;
  v_result       estimate_document_coverage;
BEGIN
  SELECT count(*) INTO v_uploaded FROM files WHERE processing_batch_id = p_batch_id;

  SELECT jsonb_agg(jsonb_build_object(
      'file_id', f.id, 'filename', f.filename, 'document_type', pd.document_type
    ) ORDER BY f.filename)
    INTO v_contributing
    FROM files f
    JOIN project_documents pd ON pd.file_id = f.id
    WHERE f.processing_batch_id = p_batch_id AND pd.extraction_status = 'complete';

  -- A document counts as "missing" whenever Stage 1/2 has not durably
  -- recorded it complete — whether that's because it genuinely failed
  -- (files.intake_status derived to 'failed', migration 052) or simply
  -- hasn't been attempted/finished yet. Both are equally true today: the
  -- builder doesn't yet know an estimate exists, so "why" matters less
  -- than "which documents".
  SELECT jsonb_agg(jsonb_build_object(
      'file_id', f.id, 'filename', f.filename,
      'status', CASE WHEN f.intake_status = 'failed' THEN 'failed' ELSE 'pending' END
    ) ORDER BY f.filename)
    INTO v_missing
    FROM files f
    WHERE f.processing_batch_id = p_batch_id
      AND NOT EXISTS (
        SELECT 1 FROM project_documents pd
        WHERE pd.file_id = f.id AND pd.extraction_status = 'complete'
      );

  v_analyzed := COALESCE(jsonb_array_length(v_contributing), 0);
  v_coverage_pct := CASE WHEN v_uploaded = 0 THEN 0 ELSE round(100.0 * v_analyzed / v_uploaded, 1) END;

  -- Confidence tier is coverage-only (deliberately distinct from
  -- builder_status below, which also folds in missing-trade/assumption
  -- signals) — a plain, honest answer to "how much of what I uploaded did
  -- WorkA actually read", independent of how the estimate downstream of
  -- that turned out. Thresholds (70 / 30) are not derived from production
  -- telemetry — none exists yet for this specific signal — they're picked
  -- to match the SAME two thresholds compute_builder_status uses below, so
  -- confidence_level and builder_status never visually disagree for the
  -- same coverage number. Revisit both together once real usage data
  -- exists (same posture CLAUDE.md documents for the 0.93 embedding
  -- de-duplication threshold: a stated, reviewable starting point, not a
  -- claimed-optimal constant).
  v_confidence := CASE
    WHEN v_coverage_pct >= 70 THEN 'high'
    WHEN v_coverage_pct >= 30 THEN 'medium'
    ELSE 'low'
  END;

  v_result.documents_uploaded := v_uploaded;
  v_result.documents_analyzed := v_analyzed;
  v_result.documents_failed_or_pending := v_uploaded - v_analyzed;
  v_result.coverage_percentage := v_coverage_pct;
  v_result.confidence_level := v_confidence;
  v_result.contributing_documents := COALESCE(v_contributing, '[]'::jsonb);
  v_result.missing_documents := COALESCE(v_missing, '[]'::jsonb);

  RETURN v_result;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION compute_document_coverage(uuid) IS
  'Read-only: how many of a batch''s uploaded documents were actually classified by Stage 1/2 (project_documents.extraction_status = ''complete''), independent of whether a quote/Stage 6 has run yet. contributing_documents/missing_documents are for direct UI display ("Included: ... / Not analysed: ..."). Generates nothing, mutates nothing.';

-- ── estimate_runs: persist the coverage snapshot alongside builder_status ──
ALTER TABLE estimate_runs
  ADD COLUMN IF NOT EXISTS coverage_documents_uploaded integer,
  ADD COLUMN IF NOT EXISTS coverage_documents_analyzed integer,
  ADD COLUMN IF NOT EXISTS coverage_percentage numeric,
  ADD COLUMN IF NOT EXISTS confidence_level text CHECK (confidence_level IN ('high', 'medium', 'low')),
  ADD COLUMN IF NOT EXISTS contributing_documents jsonb,
  ADD COLUMN IF NOT EXISTS missing_documents jsonb,
  -- Additive reason-code taxonomy alongside the existing free-text
  -- needs_review_reason (migration 078) — NOT a replacement. The existing
  -- generic branches (batch not found / no quote / no line items /
  -- missing-trade-or-assumption) each get their own stable code so a
  -- dashboard or the UI can branch on machine-readable outcome without
  -- string-matching needs_review_reason. 'missing_required_documents'
  -- (mentioned in the product ask this migration implements) is
  -- deliberately NOT one of these codes: it would require a concept of
  -- "which document types are required for this project" that does not
  -- exist anywhere in this schema today (scope_items/clarifying_questions
  -- know about missing TRADE coverage, not missing DOCUMENT TYPES) —
  -- inventing that taxonomy is a real product decision, not something to
  -- fabricate inside a status-calculation migration. partial_trade_coverage
  -- (which does have real backing, via scope_items) covers the adjacent,
  -- already-supported case.
  ADD COLUMN IF NOT EXISTS needs_review_reason_code text
    CHECK (needs_review_reason_code IN (
      'batch_not_found',
      'no_estimate_generated',
      'no_usable_line_items',
      'insufficient_document_coverage',
      'partial_document_coverage',
      'partial_trade_coverage',
      'unresolved_assumptions'
    ));

COMMENT ON COLUMN estimate_runs.coverage_percentage IS
  'Snapshot of compute_document_coverage(batch_id).coverage_percentage at the moment builder_status was finalized. See compute_document_coverage for how "analysed" is defined.';
COMMENT ON COLUMN estimate_runs.needs_review_reason_code IS
  'Machine-readable companion to needs_review_reason (migration 078), populated by the same compute_builder_status call. Additive: existing reason strings are unchanged, this only adds a stable code for UI/dashboard branching.';

-- ── compute_builder_status: now coverage-aware ──────────────────────────
-- Return shape changes (adds reason_code) — CREATE OR REPLACE cannot alter
-- OUT parameters of an existing RETURNS TABLE function, so drop first.
DROP FUNCTION IF EXISTS compute_builder_status(uuid);

CREATE OR REPLACE FUNCTION compute_builder_status(p_batch_id uuid)
RETURNS TABLE(builder_status text, reason text, reason_code text, coverage estimate_document_coverage) AS $$
DECLARE
  v_batch document_processing_batches%ROWTYPE;
  v_coverage estimate_document_coverage;
  v_coverage_note text;
  v_line_item_count int;
  v_missing_trade_count int;
  v_unresolved_conservative int;
  -- Coverage tier thresholds — see compute_document_coverage's own comment
  -- for the same numbers and the rationale for picking them together.
  -- INSUFFICIENT: below this, an estimate is not defensible regardless of
  -- what else looks complete — mirrors the product's own worked example
  -- (2 of 7 documents ~= 29% -> "needs review", not "ready with warnings").
  -- SUFFICIENT: at or above this, coverage on its own no longer forces a
  -- downgrade (existing missing-trade/assumption checks still can).
  -- Between the two: partial coverage always surfaces as at least a
  -- warning, even when the trades that DID get read happen to look
  -- complete — a low read rate is itself a trust signal, independent of
  -- whether the subset read happened to line up with the trade list.
  c_insufficient_pct constant numeric := 30;
  c_sufficient_pct    constant numeric := 70;
BEGIN
  SELECT * INTO v_batch FROM document_processing_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN QUERY SELECT 'NEEDS_REVIEW'::text, 'Batch record not found.'::text, 'batch_not_found'::text, NULL::estimate_document_coverage;
    RETURN;
  END IF;

  v_coverage := compute_document_coverage(p_batch_id);
  v_coverage_note := format(
    'Document coverage: %s of %s document(s) analysed (%s%%).',
    v_coverage.documents_analyzed, v_coverage.documents_uploaded, v_coverage.coverage_percentage
  );

  IF v_batch.quote_id IS NULL THEN
    IF v_coverage.coverage_percentage < c_insufficient_pct THEN
      RETURN QUERY SELECT 'NEEDS_REVIEW'::text,
        format('%s Insufficient document coverage to produce a reliable estimate.', v_coverage_note),
        'insufficient_document_coverage'::text, v_coverage;
      RETURN;
    END IF;
    RETURN QUERY SELECT 'NEEDS_REVIEW'::text,
      format('%s %s', v_coverage_note, COALESCE(
        (SELECT f.failure_reason FROM files f WHERE f.processing_batch_id = p_batch_id AND f.failure_reason IS NOT NULL ORDER BY f.id LIMIT 1),
        'No estimate could be generated in the time available. Automated estimation stopped before producing any priced line items.'
      )),
      'no_estimate_generated'::text, v_coverage;
    RETURN;
  END IF;

  SELECT count(*) INTO v_line_item_count
  FROM quote_line_items
  WHERE quote_id = v_batch.quote_id AND assumption_status IS DISTINCT FROM 'excluded';

  IF v_line_item_count = 0 THEN
    RETURN QUERY SELECT 'NEEDS_REVIEW'::text,
      format('%s A quote record was created but no usable line items were generated.', v_coverage_note),
      'no_usable_line_items'::text, v_coverage;
    RETURN;
  END IF;

  -- A quote with real line items exists, but coverage was low enough that
  -- the estimate isn't defensible regardless — overrides what would
  -- otherwise be a clean READY. This is the one place coverage can force
  -- NEEDS_REVIEW even though "an estimate" technically exists.
  IF v_coverage.coverage_percentage < c_insufficient_pct THEN
    RETURN QUERY SELECT 'NEEDS_REVIEW'::text,
      format(
        '%s Insufficient document coverage to produce a defensible estimate (%s line item(s) generated from a small fraction of the uploaded documents).',
        v_coverage_note, v_line_item_count
      ),
      'insufficient_document_coverage'::text, v_coverage;
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

  -- Partial coverage (between the two thresholds) always surfaces as at
  -- least a warning, even if missing-trade/assumption checks alone came
  -- back clean — see the threshold comment above for why.
  IF v_coverage.coverage_percentage < c_sufficient_pct THEN
    RETURN QUERY SELECT 'ESTIMATE_READY_WITH_WARNINGS'::text,
      format(
        '%s Estimate generated with partial documentation (%s line item(s)). Review missing items before sending.%s',
        v_coverage_note, v_line_item_count,
        CASE WHEN v_missing_trade_count > 0 OR v_unresolved_conservative > 0
          THEN format(' %s scoped trade(s) missing line items, %s assumption(s) need confirmation.', v_missing_trade_count, v_unresolved_conservative)
          ELSE ''
        END
      ),
      'partial_document_coverage'::text, v_coverage;
    RETURN;
  END IF;

  IF v_missing_trade_count > 0 OR v_unresolved_conservative > 0 THEN
    RETURN QUERY SELECT 'ESTIMATE_READY_WITH_WARNINGS'::text,
      format(
        '%s Preliminary estimate generated (%s line item(s)). %s scoped trade(s) missing line items, %s assumption(s) need confirmation — review before sending.',
        v_coverage_note, v_line_item_count, v_missing_trade_count, v_unresolved_conservative
      ),
      (CASE WHEN v_missing_trade_count > 0 THEN 'partial_trade_coverage' ELSE 'unresolved_assumptions' END)::text,
      v_coverage;
    RETURN;
  END IF;

  RETURN QUERY SELECT 'ESTIMATE_READY'::text,
    format('%s Estimate complete — %s line items.', v_coverage_note, v_line_item_count),
    NULL::text, v_coverage;
END;
$$ LANGUAGE plpgsql STABLE;

COMMENT ON FUNCTION compute_builder_status IS
  'Derives the builder-facing outcome (ESTIMATE_READY / ESTIMATE_READY_WITH_WARNINGS / NEEDS_REVIEW), a human-readable reason, a machine-readable reason_code, and the full document-coverage snapshot for a batch. Coverage (compute_document_coverage) is now a first-class input alongside the pre-existing missing-trade/unresolved-assumption signals: below 30% analysed, the run is NEEDS_REVIEW regardless of whether a quote technically exists; between 30-70%, the run is at best ESTIMATE_READY_WITH_WARNINGS regardless of how complete the trades that WERE read look; at or above 70%, coverage no longer forces a downgrade on its own. Still reuses the exact same missing-trade/unresolved-conservative-assumption definitions as lib/estimating/readiness.ts''s send gate. Does NOT gate sending — getSendBlockingReasons remains the sole send-time authority, untouched by this migration.';

-- ── reconcile_estimate_run / enforce_estimate_deadlines: persist coverage ──
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
  -- A composite-typed variable (v_coverage) cannot appear in the same
  -- multi-target `SELECT ... INTO a, b, c, composite_var` list as plain
  -- scalar targets — PL/pgSQL rejects that with "is not a scalar variable"
  -- (confirmed live: this is exactly what made the first deploy of this
  -- migration fail outright, so nothing in this file had actually taken
  -- effect despite being pushed). Capture the whole compute_builder_status
  -- row into a record instead, then assign fields individually below.
  v_cbs record;
BEGIN
  SELECT * INTO v_batch FROM document_processing_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

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
  'Derives and upserts one batch''s estimate_runs projection row (migrations 056-078), plus (migration 079): persists the compute_document_coverage snapshot and needs_review_reason_code alongside builder_status, using the same set-once/COALESCE semantics as builder_status itself.';

CREATE OR REPLACE FUNCTION enforce_estimate_deadlines()
RETURNS TABLE(estimate_run_id uuid, job_id uuid, batch_id uuid, builder_status text, reason text) AS $$
DECLARE
  r record;
  v_status text;
  v_reason text;
  v_reason_code text;
  v_coverage estimate_document_coverage;
  -- See reconcile_estimate_run's matching comment — a composite-typed
  -- variable can't sit in a multi-target scalar INTO list.
  v_cbs record;
BEGIN
  FOR r IN
    SELECT er.id, er.job_id, er.batch_id, er.status
    FROM estimate_runs er
    WHERE er.deadline_at < now()
      AND er.builder_status IS NULL
    FOR UPDATE SKIP LOCKED
  LOOP
    SELECT * INTO v_cbs FROM compute_builder_status(r.batch_id) cbs;
    v_status := v_cbs.builder_status;
    v_reason := v_cbs.reason;
    v_reason_code := v_cbs.reason_code;
    v_coverage := v_cbs.coverage;
    v_reason := format('15-minute processing window exceeded (was in stage: %s). %s', r.status, v_reason);

    UPDATE estimate_runs
    SET builder_status = v_status,
        needs_review_reason = v_reason,
        needs_review_reason_code = v_reason_code,
        coverage_documents_uploaded = (v_coverage).documents_uploaded,
        coverage_documents_analyzed = (v_coverage).documents_analyzed,
        coverage_percentage = (v_coverage).coverage_percentage,
        confidence_level = (v_coverage).confidence_level,
        contributing_documents = (v_coverage).contributing_documents,
        missing_documents = (v_coverage).missing_documents,
        completed_at = COALESCE(completed_at, now())
    WHERE id = r.id;

    INSERT INTO estimate_run_events (estimate_run_id, from_status, to_status, detail)
    VALUES (r.id, r.status, r.status, jsonb_build_object(
      'event', 'deadline_enforced', 'builder_status', v_status, 'reason', v_reason,
      'coverage_percentage', (v_coverage).coverage_percentage
    ));

    estimate_run_id := r.id; job_id := r.job_id; batch_id := r.batch_id;
    builder_status := v_status; reason := v_reason;
    RETURN NEXT;
  END LOOP;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION enforce_estimate_deadlines IS
  'The 15-minute SLA watchdog (migration 078), now also persisting the document-coverage snapshot (migration 079) at the moment it finalizes a run. Unchanged trigger condition and unchanged guarantee: every run reaches ESTIMATE_READY, ESTIMATE_READY_WITH_WARNINGS, or NEEDS_REVIEW within its 15-minute window, never silence — this migration only makes WHY visible.';

NOTIFY pgrst, 'reload schema';
