-- 083_retail_baseline_pricing.sql
-- Phase 0 of the pricing-intelligence design (see the investigation report
-- this migration implements): adds ONE new pricing tier — retail/material
-- baseline — slotted between Tier 3 (builder_supplier_rates) and Tier 4
-- (cost_rates) in lib/pricing.ts's existing resolveRateForKey(). This is not
-- a parallel pricing system: it reuses the existing catalogue-matching
-- machinery (tokenize/matchLineItemKey), the existing quote_line_items
-- material_cost/labour_cost columns (migration 012, never populated by any
-- code path until this change), and the existing pricing_source/confidence
-- plumbing in priceLineItems().
--
-- Retail data prices MATERIALS ONLY. A Bunnings/retail price is never
-- treated as an installed rate — it is always combined with a separate
-- labour_rate_benchmarks lookup to produce a composite installed estimate.
-- If either half is missing, this tier does not resolve and the existing
-- chain falls through to Tier 4/5 as before.

-- ─── market_material_prices — Tier 3.5 material baseline ──────────────────────
CREATE TABLE IF NOT EXISTS market_material_prices (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  source            text        NOT NULL,   -- 'bunnings' | 'reece' | 'beaumont_tiles' | ...
  trade_category_id integer     NOT NULL REFERENCES trade_categories(id),
  -- Links into the SAME catalogue key space cost_rates uses, so
  -- matchLineItemKey()/resolveRateForKey() treat this as just another
  -- catalogue entry, not a separate lookup mechanism. Curated (a human
  -- confirms the mapping when the row is added), never auto-generated.
  line_item_key     text        NOT NULL,
  brand             text,
  product_name      text        NOT NULL,
  unit              text        NOT NULL,
  unit_price        numeric(12,2) NOT NULL,  -- material only, never assumed to include install
  price_includes_gst boolean    NOT NULL DEFAULT true,
  region            text        CHECK (region IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  source_url        text,
  captured_at       timestamptz NOT NULL DEFAULT now(),
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (line_item_key, region)
);

COMMENT ON TABLE market_material_prices IS 'Tier 3.5 of the pricing hierarchy (migration 083): curated, periodically-refreshed public retail material prices. Never scraped automatically — captured_at exists precisely so a stale row is visible rather than silently trusted forever. Material cost only; see labour_rate_benchmarks for the other half of an installed estimate.';
COMMENT ON COLUMN market_material_prices.line_item_key IS 'Shares the same key space as cost_rates.line_item_key and participates in the same matchLineItemKey() catalogue — a brand/product-specific entry naturally outranks a generic cost_rates entry when a description names the product, by the existing token-overlap scoring (more of the entry''s own tokens matched = higher score), with no change to the matcher itself.';

CREATE INDEX IF NOT EXISTS market_material_prices_key_idx ON market_material_prices(line_item_key);
CREATE INDEX IF NOT EXISTS market_material_prices_trade_idx ON market_material_prices(trade_category_id);

ALTER TABLE market_material_prices ENABLE ROW LEVEL SECURITY;
CREATE POLICY "market_material_prices_public_read" ON market_material_prices FOR SELECT USING (true);

-- ─── labour_rate_benchmarks — the other half of an installed estimate ─────────
CREATE TABLE IF NOT EXISTS labour_rate_benchmarks (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_category_id integer     NOT NULL REFERENCES trade_categories(id),
  unit              text        NOT NULL,
  region            text        CHECK (region IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  labour_rate       numeric(12,2) NOT NULL,  -- $/unit, labour only
  source            text        NOT NULL DEFAULT 'seed' CHECK (source IN ('seed', 'learned')),
  sample_count      integer     NOT NULL DEFAULT 1,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (trade_category_id, unit, region)
);

COMMENT ON TABLE labour_rate_benchmarks IS 'Generic per-trade $/unit labour benchmark (migration 083) — the piece of an installed rate that no retail source can ever provide. Seeded with a small curated starter set; source flips to ''learned'' once real quote_line_items.labour_cost data exists to refine it (not implemented in this migration — a deliberate future step, not required for Phase 0 to work).';

CREATE INDEX IF NOT EXISTS labour_rate_benchmarks_trade_idx ON labour_rate_benchmarks(trade_category_id);

ALTER TABLE labour_rate_benchmarks ENABLE ROW LEVEL SECURITY;
CREATE POLICY "labour_rate_benchmarks_public_read" ON labour_rate_benchmarks FOR SELECT USING (true);

-- ─── quote_line_items: new pricing_source value ────────────────────────────
ALTER TABLE quote_line_items DROP CONSTRAINT IF EXISTS quote_line_items_pricing_source_check;
ALTER TABLE quote_line_items
  ADD CONSTRAINT quote_line_items_pricing_source_check
    CHECK (pricing_source IN (
      'document', 'cost_rates', 'cost_rates_exact', 'cost_rates_normalized',
      'builder_rate', 'network_rate', 'category_rate', 'ai_measured_rate',
      'ai_allowance', 'retail_baseline', 'manual', 'unresolved'
    ));

-- ─── builder_learned_rates: distinguish quote-approval vs actual-cost samples ──
-- Both provenances already fold into the SAME running average (unchanged) —
-- this column only tracks whether an actual-cost sample has EVER informed
-- the rate, so pricing UI can show "confirmed by a completed job" rather
-- than only "confirmed by a past quote", without needing a full per-sample
-- ledger (that would be overengineering for what this is used for).
ALTER TABLE builder_learned_rates
  ADD COLUMN IF NOT EXISTS learned_from text NOT NULL DEFAULT 'quote_approval'
    CHECK (learned_from IN ('quote_approval', 'actual_cost'));

-- ─── cost_reconciliation: supplier variance (Phase 2) ──────────────────────
ALTER TABLE cost_reconciliation
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;

COMMENT ON COLUMN cost_reconciliation.supplier_id IS 'Optional (migration 083) — which supplier a trade''s actual cost came through, when known. Nullable; most reconciliation entries today have no supplier attribution and that is fine. Enables a future "which supplier''s pricing holds up over time" query — not built in this migration.';

-- ─── upsert_learned_rate: weighted, provenance-aware (backward compatible) ─────
-- New params default to today's behaviour exactly (p_weight=1,
-- p_learned_from='quote_approval'), so every existing caller
-- (captureLearnedRates, unchanged) keeps working with no code change.
-- An actual-cost sample is weighted higher (p_weight=2 from the caller) —
-- ground truth from a completed job should move the average faster than a
-- quoted-but-unverified sale price. learned_from only ever upgrades to
-- 'actual_cost', never back down, once a real sample has landed.
CREATE OR REPLACE FUNCTION upsert_learned_rate(
  p_builder_id uuid,
  p_line_item_key text,
  p_rate numeric,
  p_unit text,
  p_weight integer DEFAULT 1,
  p_learned_from text DEFAULT 'quote_approval'
) RETURNS void AS $$
BEGIN
  INSERT INTO builder_learned_rates (builder_id, line_item_key, rate, unit, sample_count, learned_from, updated_at)
  VALUES (p_builder_id, p_line_item_key, p_rate, p_unit, p_weight, p_learned_from, now())
  ON CONFLICT (builder_id, line_item_key) DO UPDATE SET
    rate = ROUND(
      ((builder_learned_rates.rate * builder_learned_rates.sample_count) + (p_rate * p_weight))
      / (builder_learned_rates.sample_count + p_weight),
      2
    ),
    sample_count = builder_learned_rates.sample_count + p_weight,
    unit = p_unit,
    learned_from = CASE WHEN p_learned_from = 'actual_cost' THEN 'actual_cost' ELSE builder_learned_rates.learned_from END,
    updated_at = now();
END;
$$ LANGUAGE plpgsql;

-- ─── Starter seed — curated, not scraped (see Phase 2 for automation) ──────────
-- Deliberately small: the six categories the investigation report flagged as
-- most reliably retail-priced. Meant to be extended over time, not exhaustive.

INSERT INTO market_material_prices (source, trade_category_id, line_item_key, brand, product_name, unit, unit_price) VALUES
  ('bunnings', 2,  'retail_framing_pine_90x45',           NULL,             'MGP10 Pine Framing Timber 90x45mm',   'lm',   8.90),
  ('bunnings', 4,  'retail_hardie_linea_weatherboard',    'James Hardie',   'Linea Weatherboard',                  'm2',  46.80),
  ('bunnings', 5,  'retail_insulation_wall_batts_r25',    'Pink Batts',     'R2.5 Wall Batts',                     'm2',  12.50),
  ('bunnings', 6,  'retail_plasterboard_10mm',            'CSR Gyprock',    '10mm Plasterboard Standard Sheet',    'm2',   9.80),
  ('bunnings', 9,  'retail_paint_interior',               'Dulux',          'Wash&Wear Low Sheen Interior Paint',  'm2',   6.20),
  ('bunnings', 11, 'retail_tapware_mixer_standard',       'Methven',        'Standard Basin Mixer Tap',            'each', 89.00)
ON CONFLICT (line_item_key, region) DO NOTHING;

INSERT INTO labour_rate_benchmarks (trade_category_id, unit, labour_rate, source) VALUES
  (2,  'lm',   22.00, 'seed'),
  (4,  'm2',   38.00, 'seed'),
  (5,  'm2',    9.00, 'seed'),
  (6,  'm2',   16.00, 'seed'),
  (9,  'm2',   14.00, 'seed'),
  (11, 'each', 65.00, 'seed')
ON CONFLICT (trade_category_id, unit, region) DO NOTHING;

NOTIFY pgrst, 'reload schema';
