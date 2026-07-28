-- 084_pricing_intelligence_hardening.sql
-- Production-hardening fixes for the pricing-intelligence work (migration
-- 083), found by audit — not a rebuild or a new feature, purely closing
-- gaps in what already shipped.
--
-- FIX 4 (this migration's only schema change): market_material_prices and
-- labour_rate_benchmarks both used a plain UNIQUE(..., region) constraint,
-- where region is nullable (NULL = national default, the common case). As
-- with network_rate_aggregates before migration 020 fixed the identical
-- issue there, standard SQL treats every NULL as distinct for uniqueness
-- purposes — so two national ('bunnings', region=NULL) rows for the same
-- line_item_key (or the same trade_category_id+unit for labour benchmarks)
-- would NOT be rejected by the existing constraint, and a re-run of a seed
-- script or a careless manual insert could silently duplicate national
-- pricing data. Recreated with NULLS NOT DISTINCT (Postgres 15+), exactly
-- the fix already proven for network_rate_aggregates in migration 020.

ALTER TABLE market_material_prices
  DROP CONSTRAINT IF EXISTS market_material_prices_line_item_key_region_key;
ALTER TABLE market_material_prices
  ADD CONSTRAINT market_material_prices_line_item_key_region_key
  UNIQUE NULLS NOT DISTINCT (line_item_key, region);

ALTER TABLE labour_rate_benchmarks
  DROP CONSTRAINT IF EXISTS labour_rate_benchmarks_trade_category_id_unit_region_key;
ALTER TABLE labour_rate_benchmarks
  ADD CONSTRAINT labour_rate_benchmarks_trade_category_id_unit_region_key
  UNIQUE NULLS NOT DISTINCT (trade_category_id, unit, region);

NOTIFY pgrst, 'reload schema';
