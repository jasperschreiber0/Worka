-- 069_estimator_corrections.sql
-- Phase 2 of the estimator rebuild (project-intelligence architecture,
-- reviewed 23 Jul 2026): the learning engine's capture side. Every time a
-- builder corrects an AI-predicted quantity or unit, that correction is
-- recorded — prediction, correction, optional reason, and enough context
-- to find it again for a comparable future project.
--
-- Deliberately scoped to quantity/unit corrections only, not price. A price
-- correction already has its own, older learning mechanism (Tier 1
-- builder_learned_rates, fed by captureLearnedRates on job activation) —
-- duplicating that here would split one signal across two tables. This
-- table is for the thing that has NO learning loop today: "AI predicted
-- Brickwork = 450sqm, the builder corrected it to 520sqm because of
-- additional garage walls."
--
-- Capture point (this migration's application-side pair): the EXISTING
-- POST /api/assumptions/[quoteId]/resolve route, resolution = 'adjusted' —
-- the only place a quantity/unit is actually correctable today. No new UI
-- required for capture to start working; `reason` stays optional there,
-- deliberately never a required field standing between a builder and a
-- quick fix.
--
-- Retrieval (lib/estimating/corrections.ts, this same change) is built and
-- unit-tested but NOT wired into any live Claude call yet — there is no
-- trade-agent to feed it. Per the architecture review, the multi-trade
-- split is deliberately deferred until a single estimator has been
-- benchmarked reading from the Phase 1 project model; retrieval is ready
-- for whichever consumer needs it once that benchmark lands.

CREATE TABLE IF NOT EXISTS estimator_corrections (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  quote_id            uuid        NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  quote_line_item_id  uuid        REFERENCES quote_line_items(id) ON DELETE SET NULL,
  trade_category_id   int         NOT NULL REFERENCES trade_categories(id),
  field               text        NOT NULL CHECK (field IN ('quantity', 'unit')),
  -- Null only when the AI genuinely had no value at all (a Gate 1 item —
  -- no unit ever extracted) — never a fabricated placeholder.
  ai_predicted        text,
  human_corrected     text        NOT NULL,
  -- Optional, free text. Never required — see this migration's header.
  reason              text,
  corrected_by        uuid        NOT NULL REFERENCES builders(id),
  corrected_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE estimator_corrections IS
  'The estimator rebuild''s learning-engine capture table: one row per builder correction to an AI-predicted quantity or unit. Price corrections are NOT captured here — see Tier 1 builder_learned_rates for that existing loop. Written by POST /api/assumptions/[quoteId]/resolve on resolution=adjusted; read by lib/estimating/corrections.ts''s retrieval function, not yet wired into any live estimate call.';

COMMENT ON COLUMN estimator_corrections.ai_predicted IS
  'The value in place immediately before this correction. Null only for a Gate 1 item that had no unit/quantity at all to begin with — distinguishes "AI got it wrong" from "AI had nothing to get right".';

CREATE INDEX IF NOT EXISTS estimator_corrections_job_idx ON estimator_corrections(job_id);
CREATE INDEX IF NOT EXISTS estimator_corrections_trade_idx ON estimator_corrections(trade_category_id);

-- ─── quote_line_items: provenance for the learning loop ────────────────────
ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS predicted_by text NOT NULL DEFAULT 'ai'
  CHECK (predicted_by IN ('ai', 'human'));
ALTER TABLE quote_line_items ADD COLUMN IF NOT EXISTS correction_id uuid REFERENCES estimator_corrections(id) ON DELETE SET NULL;

COMMENT ON COLUMN quote_line_items.predicted_by IS
  'Whether this line''s current quantity/unit came from AI extraction (default) or a builder correction. Flipped to ''human'' by the same write that inserts the matching estimator_corrections row.';
COMMENT ON COLUMN quote_line_items.correction_id IS
  'The estimator_corrections row that most recently changed this line''s quantity/unit, if any. Null for a line never corrected.';

-- ─── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE estimator_corrections ENABLE ROW LEVEL SECURITY;

CREATE POLICY "estimator_corrections_own_builder" ON estimator_corrections
  FOR ALL USING (job_id IN (SELECT id FROM jobs WHERE builder_id = auth.uid()));
