-- ── 092: compute_builder_status must not claim ESTIMATE_READY before
--         pricing and QA have actually run ──────────────────────────────
--
-- Root cause found live, 2026-08-23, immediately after migration 091 let
-- the previously-oscillating batch d58c3e92 finally converge: Stage 6
-- completed all 13 trades and created a real quote
-- (700fc7b2-db92-4373-af21-827030e72f84, 174 line items) via the
-- recovery-cron-driven resume path (no SSE client connected, no builder
-- ever opened the quote). estimate_runs.builder_status was immediately
-- computed as 'ESTIMATE_READY' -- but the quote's total_cost was NULL and
-- qa_report was NULL: pricing (lib/pricing.ts's ensureQuotePriced) and QA
-- (lib/estimating/qa.ts's runQualityAssurance) had never run, because both
-- are Next.js-side steps that, per this codebase's existing architecture,
-- only fire from the SSE intake poller or lazily from the quote GET route
-- -- neither of which had ever been invoked for this job. This is exactly
-- the "apparently-successful-but-incomplete quote" failure mode: a
-- builder polling/checking this job would have been told their estimate
-- was ready to review, and opened a quote showing $0 total cost with no
-- quality checks run against it.
--
-- compute_builder_status (migration 079) already checks quote existence,
-- line-item count, document coverage, missing-trade coverage, and
-- unresolved conservative assumptions before returning ESTIMATE_READY /
-- ESTIMATE_READY_WITH_WARNINGS -- but never checked whether pricing or QA
-- had actually completed. This closes that gap the same way the other
-- checks in this function already work: read the real state directly
-- (quotes.total_cost, quotes.qa_report), never a cached/assumed signal.
--
-- Deliberately conservative on what counts as "priced": at least one
-- non-excluded line item must have a resolved total (rate x quantity,
-- pc_allowance, or provisional_sum can all leave rate/total legitimately
-- null on individual unpriceable lines per lib/pricing.ts's own
-- best-effort contract -- "an unpriceable item keeps rate = null and is
-- excluded from totals rather than failing the pipeline"), so this checks
-- that pricing has been ATTEMPTED (quotes.total_cost is not null, meaning
-- recomputeQuoteTotals has run at least once) rather than requiring every
-- single line item individually priced, which would incorrectly block a
-- quote that legitimately contains some PC/provisional items.
--
-- This does NOT touch getSendBlockingReasons (lib/estimating/readiness.ts)
-- -- that remains the sole send-time authority, exactly as migration 079's
-- own comment already states for its other checks. This only stops the
-- BUILDER-FACING STATUS SIGNAL from claiming readiness before the
-- prerequisite work has run; it does not change what's allowed to be sent
-- to a client.

CREATE OR REPLACE FUNCTION compute_builder_status(p_batch_id uuid)
RETURNS TABLE(builder_status text, reason text, reason_code text, coverage estimate_document_coverage) AS $$
DECLARE
  v_batch document_processing_batches%ROWTYPE;
  v_coverage estimate_document_coverage;
  v_coverage_note text;
  v_line_item_count int;
  v_missing_trade_count int;
  v_unresolved_conservative int;
  v_quote_total_cost numeric;
  v_quote_has_qa boolean;
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

  -- New in migration 092: a quote with line items but that has never been
  -- through pricing/QA is not ready for a builder to review, regardless of
  -- how complete the trade coverage otherwise looks. Checked before the
  -- coverage/missing-trade/assumption checks below so it can never be
  -- masked by an otherwise-clean result.
  SELECT total_cost, (qa_report IS NOT NULL) INTO v_quote_total_cost, v_quote_has_qa
  FROM quotes WHERE id = v_batch.quote_id;

  IF v_quote_total_cost IS NULL THEN
    RETURN QUERY SELECT 'NEEDS_REVIEW'::text,
      format('%s %s line item(s) generated but pricing has not run yet — totals are not yet available.', v_coverage_note, v_line_item_count),
      'pricing_not_run'::text, v_coverage;
    RETURN;
  END IF;

  IF NOT v_quote_has_qa THEN
    RETURN QUERY SELECT 'NEEDS_REVIEW'::text,
      format('%s %s line item(s) priced but quality assurance has not run yet.', v_coverage_note, v_line_item_count),
      'qa_not_run'::text, v_coverage;
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
  'Derives the builder-facing outcome (ESTIMATE_READY / ESTIMATE_READY_WITH_WARNINGS / NEEDS_REVIEW), a human-readable reason, a machine-readable reason_code, and the full document-coverage snapshot for a batch. As of migration 092, a quote with line items but with total_cost still NULL (pricing never ran) or qa_report still NULL (QA never ran) is NEEDS_REVIEW regardless of how complete trade coverage looks — closes a live-confirmed gap where a quote created via the recovery-cron resume path (no SSE client, no builder ever opening it) could be marked ESTIMATE_READY while genuinely unpriced and un-QAd. Coverage (compute_document_coverage) below 30% analysed is NEEDS_REVIEW regardless of pricing/QA state; between 30-70%, at best ESTIMATE_READY_WITH_WARNINGS; at or above 70%, coverage no longer forces a downgrade on its own. Still reuses the exact same missing-trade/unresolved-conservative-assumption definitions as lib/estimating/readiness.ts''s send gate. Does NOT gate sending — getSendBlockingReasons remains the sole send-time authority, untouched by this migration.';

NOTIFY pgrst, 'reload schema';
