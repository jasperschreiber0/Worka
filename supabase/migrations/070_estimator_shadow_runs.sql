-- 070_estimator_shadow_runs.sql
-- Phase 3 of the estimator rebuild (project-intelligence architecture,
-- reviewed 23 Jul 2026): shadow-mode comparison between the current
-- fact-selection Stage 3/6 and a new estimator reasoning from the Phase 1
-- project model + Phase 3's deterministic trade views.
--
-- NOT a cutover. The shadow estimator's output is never written to
-- scope_items / clarifying_questions / quote_line_items — the live
-- pricing engine, QA, confidence scoring, assumptions, and review workflow
-- are completely unchanged (see runProjectModelShadowEstimate,
-- smooth-responder/index.ts). This table exists purely to make the two
-- estimators comparable without duplicating what's already durable
-- elsewhere: full call inputs/outputs are already in ai_operations.result
-- (migration 054) for both the real run (call_site = 'stage_scope_
-- reasoning' / 'stage_estimate_generation') and the shadow run (call_site
-- = 'stage_scope_reasoning_shadow' / 'stage_estimate_generation_shadow')
-- — this table stores the derived comparison, with optional links back to
-- those rows for a human to drill into full content.
--
-- Honesty note: "quantity accuracy" and "scope completeness" have no
-- automatic ground truth — nothing here claims to compute either as a
-- score. What's captured is objective and derivable (token usage,
-- duration, item/question counts, average confidence) plus links to the
-- full raw output for a human to judge completeness/accuracy manually.
-- Gated off by default (PROJECT_MODEL_SHADOW_MODE_ENABLED = false in
-- smooth-responder/index.ts) — shipped dark, enabled deliberately, same
-- pattern this codebase already uses for anything that increases
-- Anthropic spend.

CREATE TABLE IF NOT EXISTS estimator_shadow_runs (
  id                            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                        uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  batch_id                      uuid        REFERENCES document_processing_batches(id) ON DELETE SET NULL,
  quote_id                      uuid        REFERENCES quotes(id) ON DELETE SET NULL,

  -- Optional pointers into ai_operations for full-content drill-down —
  -- null if that particular call didn't happen (e.g. shadow scope
  -- produced zero trades, so no shadow estimate call was made).
  real_scope_operation_id       uuid        REFERENCES ai_operations(id),
  shadow_scope_operation_id     uuid        REFERENCES ai_operations(id),
  real_estimate_operation_id    uuid        REFERENCES ai_operations(id),
  shadow_estimate_operation_id  uuid        REFERENCES ai_operations(id),

  real_input_tokens             integer,
  shadow_input_tokens           integer,
  real_output_tokens            integer,
  shadow_output_tokens          integer,
  real_duration_ms              integer,
  shadow_duration_ms            integer,

  real_scope_trade_count        integer,
  shadow_scope_trade_count      integer,
  real_clarifying_question_count   integer,
  shadow_clarifying_question_count integer,
  real_line_item_count          integer,
  shadow_line_item_count        integer,
  real_avg_confidence           numeric(5,2),
  shadow_avg_confidence         numeric(5,2),

  -- Which of the 13 trades the shadow run actually reasoned about — the
  -- shadow section runs inside the same invocation as the real one, after
  -- it, on whatever wall-clock budget remains, so a partial shadow run
  -- (fewer trades than the real one covered) is expected, not an error.
  trades_shadow_reasoned        integer[],

  notes                          text,
  created_at                     timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE estimator_shadow_runs IS
  'Derived comparison between the live fact-selection estimator and the shadow project-model estimator for one pipeline run. Never read by the live pipeline, never influences a real quote. See migration 070''s header comment for what is and is not measured here.';

CREATE INDEX IF NOT EXISTS estimator_shadow_runs_job_idx ON estimator_shadow_runs(job_id);
CREATE INDEX IF NOT EXISTS estimator_shadow_runs_created_idx ON estimator_shadow_runs(created_at);

ALTER TABLE estimator_shadow_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "estimator_shadow_runs_own_builder" ON estimator_shadow_runs
  FOR ALL USING (job_id IN (SELECT id FROM jobs WHERE builder_id = auth.uid()));
