-- ============================================================
-- WorkA — per-estimate document contribution report
-- ============================================================
-- Context: the estimating engine compresses every uploaded document into
-- project_facts, and the scope/estimate stages see only a bounded selection
-- of those facts — never the documents themselves. Until now, nothing
-- recorded which documents' facts actually made it into the prompt a given
-- estimate was generated from: a builder could upload structural
-- engineering, watch it "process ✓", and have zero of its facts influence
-- the estimate (global confidence-ordered truncation evicted low-
-- readability documents first) with no record anywhere that it happened.
--
-- The engine now uses document-balanced fact selection (every source
-- document is guaranteed a floor of the fact budget — see
-- selectFactsBalancedBySource in smooth-responder/pipeline-logic.ts) and
-- writes this column at estimate time: one JSON report per quote recording,
-- per source document, facts_extracted vs facts_used, plus any documents
-- excluded (size/batch limits) or failed outright. Surfaced to the builder
-- in QuoteView ("What WorkA read") and read by the QA engine to flag any
-- document that contributed nothing.
--
-- Shape (written by smooth-responder/index.ts, building_quote stage):
--   {
--     "documents":     [{ "document_id", "name", "facts_extracted", "facts_used" }],
--     "other_sources": { "facts_extracted", "facts_used" } | null,  -- builder answers etc.
--     "excluded":      ["filename", ...],
--     "failed":        ["filename", ...],
--     "generated_at":  timestamptz string
--   }
--
-- A snapshot of the run that produced the estimate, not a live view —
-- recomputed and overwritten whenever the engine rebuilds this quote.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS document_contribution jsonb;

COMMENT ON COLUMN quotes.document_contribution IS
  'Per-source-document facts_extracted vs facts_used accounting for the engine run that produced this quote, plus excluded/failed documents. Written by smooth-responder at estimate time; the durable answer to "did WorkA actually use my drawings?". Snapshot, not live — overwritten on each engine rebuild of this quote.';
