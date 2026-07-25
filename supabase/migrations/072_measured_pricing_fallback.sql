-- 072_measured_pricing_fallback.sql
-- Closes the "measured item -> no cost_rates match -> silently $0" gap
-- confirmed on a real quote: 19 of 24 unpriced line items had a clean,
-- Stage-3-verified quantity and unit — the failure was entirely downstream,
-- in lib/pricing.ts's rate lookup, not in scope reasoning. This is a
-- distinct problem from the AI Allowance case (migration 071, "no
-- measurable quantity at all") — these items ARE measured, they just
-- couldn't be priced. Kept as a separate pricing_source family so the two
-- are never conflated.
--
-- Widens pricing_source with four new values and replaces the placeholder
-- 'cost_rates' value from migration 071, which was added to the CHECK
-- constraint but never actually written by any code (lib/pricing.ts wrote
-- no pricing_source at all until this migration's companion code change) —
-- safe to replace outright, not a breaking rename of live data.

ALTER TABLE quote_line_items DROP CONSTRAINT IF EXISTS quote_line_items_pricing_source_check;

ALTER TABLE quote_line_items
  ADD CONSTRAINT quote_line_items_pricing_source_check
    CHECK (pricing_source IN (
      'document', 'cost_rates_exact', 'cost_rates_normalized', 'category_rate',
      'builder_rate', 'network_rate', 'ai_measured_rate', 'ai_allowance', 'manual', 'unresolved'
    ));

COMMENT ON COLUMN quote_line_items.pricing_source IS
  'Where this line''s rate/total actually came from. document: read off a source PDF. cost_rates_exact: full token-containment match against the platform rate catalogue. cost_rates_normalized: partial/synonym match against the catalogue. category_rate: no item-specific match, used a same-trade same-unit average. builder_rate/network_rate: tiers 1-3 / tier 5 of the rate hierarchy. ai_measured_rate: Claude proposed a $/unit rate for a genuinely measured item (real quantity+unit) with no catalogue match at any tier — distinct from ai_allowance, which is used when no measurable quantity exists at all. manual: builder-entered. unresolved: no source, total stays null.';

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS pricing_match_rate_pct numeric(5,2);

COMMENT ON COLUMN quotes.pricing_match_rate_pct IS
  'Percentage of included line items priced by a RELIABLE measured source (cost_rates_exact, cost_rates_normalized, document, builder_rate, network_rate) — excludes category_rate, ai_measured_rate, ai_allowance, and manual. Distinct from price_coverage_pct (which counts ANY non-null total, including allowances and estimates): this answers "does the quote have reliable measured pricing," not just "does the quote have prices."';
