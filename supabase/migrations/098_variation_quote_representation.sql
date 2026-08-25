-- 098_variation_quote_representation.sql
-- Variations v1 — Connect Contract & Margin. Closes the gap traced directly
-- in the app code: approving a variation (builder-side resolve, or the
-- client-facing share-token portal) only ever flipped variations.status —
-- it never touched quote_line_items/quotes, so contract_value/current_margin
-- (Financials v1, migration 097) silently ignored every approved variation.
--
-- Three small, targeted changes, no new tables:

-- 1. Variations need a trade category to become a valid quote_line_items row
--    (trade_category_id is NOT NULL there, migration 001). Nullable here —
--    existing variations predate this column and must not be silently
--    mutated; the application layer requires it on newly-raised variations
--    and degrades gracefully (skips quote representation with a clear
--    message) for an approval on a pre-existing row that has none.
ALTER TABLE variations
  ADD COLUMN IF NOT EXISTS trade_category_id int REFERENCES trade_categories(id);

-- 2. The durable, DB-enforced idempotency guarantee: at most one
--    quote_line_items row per variation, ever. A partial unique index
--    (not a plain UNIQUE) because most line items are NOT from a
--    variation and must be free to all have variation_id IS NULL —
--    exactly the pattern quotes_one_current_per_job (migration 061)
--    already established in this schema for the same reason.
--    ON DELETE SET NULL, not CASCADE: variations are never deleted in
--    this codebase (forward-only, no DELETE route exists), but if that
--    ever changes, the line item this variation produced should survive
--    as an ordinary quote line, not vanish.
ALTER TABLE quote_line_items
  ADD COLUMN IF NOT EXISTS variation_id uuid REFERENCES variations(id) ON DELETE SET NULL;

CREATE UNIQUE INDEX IF NOT EXISTS quote_line_items_variation_id_unique
  ON quote_line_items (variation_id)
  WHERE variation_id IS NOT NULL;

COMMENT ON COLUMN quote_line_items.variation_id IS
  'The variations row this line item was created from, if any. At most one line item per variation (quote_line_items_variation_id_unique) — the durable idempotency guarantee for variation approval. Null for every ordinary AI-extracted or manually-entered line.';

-- 3. pricing_source gains one new value. Same pattern as migrations
--    071/072/083, each of which extended this exact CHECK constraint.
ALTER TABLE quote_line_items DROP CONSTRAINT IF EXISTS quote_line_items_pricing_source_check;
ALTER TABLE quote_line_items
  ADD CONSTRAINT quote_line_items_pricing_source_check
    CHECK (pricing_source IN (
      'document', 'cost_rates', 'cost_rates_exact', 'cost_rates_normalized',
      'builder_rate', 'network_rate', 'category_rate', 'ai_measured_rate',
      'ai_allowance', 'retail_baseline', 'manual', 'variation', 'unresolved'
    ));
