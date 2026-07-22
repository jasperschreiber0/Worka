-- 066_conservative_assumptions.sql
-- Non-blocking estimation: a clarifying question Stage 3/4 flags as
-- "blocking" no longer stops runPipeline before Stage 6 (see
-- app/api/intake/[fileId]/route.ts's own SSE handling and smooth-responder/
-- index.ts) — the question is still persisted for audit/history, but the
-- pipeline now always continues to produce a quote, using an explicit,
-- disclosed assumption in place of the missing answer. Additive only: no
-- existing column's meaning changes, no existing row is touched.

-- ─── clarifying_questions.suggested_assumption ─────────────────────────────
-- Claude's own proposed default for a blocking question, from the SAME
-- Stage 3/4 call that raised it (SCOPE_REASONING_TOOL, smooth-responder/
-- index.ts) — used to build the conservative assumption applied at Stage 6.
-- Null when Claude didn't supply one; buildConservativeAssumption
-- (pipeline-logic.ts) falls back to a generic, honestly-labelled default in
-- that case rather than ever leaving the assumption blank.
ALTER TABLE clarifying_questions ADD COLUMN IF NOT EXISTS suggested_assumption text;

COMMENT ON COLUMN clarifying_questions.suggested_assumption IS
  'Claude''s own proposed default for this question, from the same Stage 3/4 call. Null if none was supplied — the pipeline falls back to a generic conservative default (see CONSERVATIVE_ASSUMPTION_FALLBACK, pipeline-logic.ts) rather than leaving the resulting assumption blank.';

-- ─── assumptions: new fields for clarifying-question-derived assumptions ───
-- Gates 1-3 (assumptions.gate IN (1,2,3)) are unaffected — these four
-- columns are null on every existing/future Gate 1-3 row. A row with
-- gate IS NULL and these populated is the NEW category: a project/
-- trade-level assumption WorkA made in place of an unanswered blocking
-- clarifying question, never tied to one specific line item
-- (line_item_id stays null for these), always disclosed rather than
-- silently applied.
ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS assumed_value text;
ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS reason text;
ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS confidence_penalty integer;
ALTER TABLE assumptions ADD COLUMN IF NOT EXISTS trade_category_id int REFERENCES trade_categories(id);

COMMENT ON COLUMN assumptions.assumed_value IS
  'The concrete default WorkA used in place of an answer to a blocking clarifying question — Claude''s own suggested_assumption if it supplied one, else the generic conservative fallback. Null for Gate 1-3 assumptions (gate IS NOT NULL).';

COMMENT ON COLUMN assumptions.reason IS
  'Why the missing answer materially affects the estimate — copied from the originating clarifying_questions row. Null for Gate 1-3 assumptions.';

COMMENT ON COLUMN assumptions.confidence_penalty IS
  'Fixed points-below-maximum this assumption guarantees on the affected trade''s line items (see BLOCKING_ASSUMPTION_CONFIDENCE_CAP/_PENALTY, pipeline-logic.ts) — a constant per assumption, not a variable delta, since one assumption can affect several line items with different starting confidences. Null for Gate 1-3 assumptions, which already have their own line-item-level confidence handling.';

COMMENT ON COLUMN assumptions.trade_category_id IS
  'Which trade this assumption''s confidence penalty was applied to — null means project-wide (the originating clarifying question had no single trade_category_id, e.g. "is this a renovation or a new build"), affecting every trade''s line items. Copied from clarifying_questions.trade_category_id. Null for Gate 1-3 assumptions, which are already tied to a specific line item instead.';
