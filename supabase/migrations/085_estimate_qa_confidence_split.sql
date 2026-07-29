-- 085_estimate_qa_confidence_split.sql
-- Estimator QA layer (design approved in the pricing-intelligence review
-- session): splits "how reliable is this estimate" into two questions that
-- were previously conflated into one number.
--
-- quotes.confidence_score (existing, unchanged) already answers "how
-- reliable is this PRICE" — it's the lowest included line-item pricing
-- confidence (computeQuoteTotals, lib/pricing.ts). It has never answered
-- "is the SCOPE itself complete and internally consistent" — a quote can
-- have 100% priced, high-confidence line items while still being missing a
-- waterproofing allowance or containing an internally-impossible paint
-- quantity. That is a construction-reasoning question, not a pricing
-- question, and this migration gives it its own number rather than
-- blending it into confidence_score and losing the distinction.
--
-- scope_confidence: derived by lib/estimating/construction-sanity.ts +
-- runQualityAssurance from missing-trade count, unresolved conservative
-- assumptions, construction-sanity rule findings (see that module), and
-- documents that contributed zero facts. Weakest-link (MIN), matching this
-- codebase's existing confidence-scoring philosophy (computeQuoteTotals
-- already uses MIN, not an average, for the same reason: one bad signal
-- must not be hidden by averaging it against good ones).
--
-- overall_estimate_confidence = MIN(confidence_score, scope_confidence) —
-- computed and stored, not left for the UI to derive, so every consumer
-- (QuoteView, PDF export, a future API caller) reads the same number.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS scope_confidence numeric(5,2),
  ADD COLUMN IF NOT EXISTS overall_estimate_confidence numeric(5,2);

COMMENT ON COLUMN quotes.scope_confidence IS 'Construction-reasoning confidence (0-100): is the scope complete and internally consistent, independent of whether the prices themselves are trustworthy. Computed by runQualityAssurance (lib/estimating/qa.ts) from missing trades, unresolved conservative assumptions, construction-sanity findings (lib/estimating/construction-sanity.ts), and silent (zero-contribution) documents. Null until QA has run at least once.';
COMMENT ON COLUMN quotes.overall_estimate_confidence IS 'MIN(confidence_score, scope_confidence) — the weakest of "is the price right" and "is the scope right". Stored, not derived client-side, so every surface shows the same number.';

NOTIFY pgrst, 'reload schema';
