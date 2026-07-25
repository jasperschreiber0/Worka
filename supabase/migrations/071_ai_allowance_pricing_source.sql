-- 071_ai_allowance_pricing_source.sql
-- Closes the "unknown quantity -> silently $0" gap: a line item Stage 6
-- couldn't measure previously had no representation between "priced" and
-- "excluded" — it just sat at total = null, contributing nothing, with no
-- record that WorkA ever understood the scope existed. This adds the
-- minimum columns to let Stage 6 propose an AI Allowance instead (a real
-- $ figure with explicit lower confidence and a stated reason) and to make
-- every line item's pricing origin traceable, which is also what makes
-- quotes.price_coverage_pct meaningful rather than a guess.
--
-- Deliberately does NOT add a new pricing_type value or touch the existing
-- CHECK constraint on quote_line_items.pricing_type — an AI Allowance is
-- represented as pricing_type = 'pc_allowance' (already exempt from Gate
-- 1/2 in both applyValidationGates copies) with pricing_source =
-- 'ai_allowance' distinguishing it from a document-sourced PC figure.
-- Additive only: every new column is nullable, existing rows read as null
-- (honest — we don't know their source retroactively), no backfill.
--
-- pricing_basis is NOT a new column — migration 014 already added it as a
-- 3-value enum ('measured' | 'inferred' | 'allowance'), CHECK-constrained,
-- and it has been completely dead since: confirmed via a full repo grep,
-- zero reads or writes anywhere in the app or edge function. A plain
-- `ADD COLUMN IF NOT EXISTS` here would have silently no-op'd against that
-- existing column, and the free-text reasoning this feature needs to write
-- ("Estimated from comparable bathroom renovations...") would have failed
-- 014's CHECK constraint at insert time. Repurposed instead: drop the
-- stale enum constraint, keep the column, correct its type to the free
-- text this feature actually needs — no second, confusingly-similar
-- column added alongside it.

ALTER TABLE quote_line_items DROP CONSTRAINT IF EXISTS quote_line_items_pricing_basis_check;

ALTER TABLE quote_line_items
  ADD COLUMN IF NOT EXISTS pricing_source text
    CHECK (pricing_source IN ('document', 'cost_rates', 'builder_rate', 'network_rate', 'ai_allowance', 'manual', 'unresolved')),
  ADD COLUMN IF NOT EXISTS original_ai_value numeric(12,2);

COMMENT ON COLUMN quote_line_items.pricing_source IS
  'Where this line''s rate/total actually came from: document (read off a source PDF), cost_rates/builder_rate/network_rate (the 5-tier rate hierarchy, tiers 4/1-3/5), ai_allowance (Stage 6 proposed a $ figure with no document or rate backing), manual (builder-entered), or unresolved (no source yet — total stays null). Populated at estimate-generation time for document/ai_allowance/unresolved; populated later by the rate-resolution pass for cost_rates/builder_rate/network_rate.';

COMMENT ON COLUMN quote_line_items.pricing_basis IS
  'Short free-text reasoning — required whenever pricing_source = ai_allowance (why this figure, e.g. "Estimated from comparable bathroom renovations; no supplier quote available") or provisional_sum (why the amount is contingent). Null for measured/document-priced items, which are self-explanatory from quantity x rate or the source document.';

COMMENT ON COLUMN quote_line_items.original_ai_value IS
  'The rate or total WorkA itself originally proposed at generation time, preserved even after a builder override changes rate/total. Not written to or read by anything yet outside this line item''s own row — the override-capture flow that would compare against it is a separate, later task.';

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS price_coverage_pct numeric(5,2);

COMMENT ON COLUMN quotes.price_coverage_pct IS
  'Percentage of included (non-excluded) line items that have a non-null total, computed by computeQuoteTotals (lib/pricing.ts) alongside total_cost/confidence_score. Exists so a quote''s total_cost is never shown without a visible signal of how much of the scope it actually reflects — see the incident where a 21%-covered quote''s total looked like a complete number with nothing to distinguish it.';
