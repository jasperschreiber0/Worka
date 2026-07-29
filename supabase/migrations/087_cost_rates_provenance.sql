-- ============================================================
-- WorkA — Cost Rates Provenance Migration 087
--
-- Part of the pricing production-hardening pass: "Create the schema/import
-- structure so rates can be added with: source, region, date, confidence,
-- unit, trade, applicability" — a pure schema addition, no rate values
-- invented or changed. cost_rates already has unit/trade_category_id/state
-- (region)/created_at (date); this adds the three still-missing provenance
-- fields so a FUTURE rate addition (e.g. the pool/lift/HVAC/windows/
-- skylights/solar-PV/technology/professional-fees coverage gaps identified
-- in the pricing coverage audit) can be entered with real provenance
-- instead of the seed's own bare (trade, key, description, unit, rate,
-- state) tuple.
--
-- Nullable, no default rate/confidence backfilled for existing 630 seed
-- rows — inventing a source/confidence for rates that already exist would
-- misrepresent them as verified when they were never sourced that way.
-- `source` for the existing seed rows is set to a plain, honest label
-- ('platform_seed_2025') rather than left null, since null would read as
-- "provenance unknown" for rows whose provenance IS known (they are the
-- original migration 017 seed) — this is metadata about existing rows,
-- not a new rate value.
-- ============================================================

ALTER TABLE cost_rates
  ADD COLUMN IF NOT EXISTS source        text,
  ADD COLUMN IF NOT EXISTS confidence    numeric(5,2) CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 100)),
  ADD COLUMN IF NOT EXISTS applicability text;

COMMENT ON COLUMN cost_rates.source IS
  'Where this rate came from — e.g. platform_seed_2025, builder_supplied, industry_publication_<name>_<year>, subcontractor_quote_<ref>. Free text, not an enum, since sourcing conventions will vary per rate added.';
COMMENT ON COLUMN cost_rates.confidence IS
  '0-100. How confident the rate library maintainer is that this rate reflects current, real market pricing for its trade/region/unit — distinct from a priced LINE ITEM''s own confidence (quote_line_items.confidence), which also reflects how well the item matched this rate. Null for rows entered before this column existed.';
COMMENT ON COLUMN cost_rates.applicability IS
  'Free-text scope note — what this rate does and does NOT include (e.g. "supply + install, excludes waterproofing membrane" or "shell only, excludes filtration/heating/fencing — see separate pool_* rates"). Exists so a future rate addition for a multi-component system (pool, HVAC, lift) can state its own boundaries explicitly instead of leaving them implicit in the description.';

UPDATE cost_rates SET source = 'platform_seed_2025' WHERE source IS NULL;
