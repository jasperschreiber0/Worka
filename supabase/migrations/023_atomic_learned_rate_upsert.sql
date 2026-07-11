-- ============================================================
-- Atomic learned-rate upsert
--
-- captureLearnedRates() (lib/pricing.ts) previously did a per-item
-- select-then-branch: read the existing running average, compute the new
-- average in JS, then update/insert. Two concurrent quote approvals for
-- the same builder/line_item_key can both read the same starting values,
-- so one update silently overwrites the other's contribution (lost
-- update) — or both try to insert and one hits the unique constraint.
--
-- This moves the read-modify-write into a single atomic UPSERT statement,
-- so the running average is always computed against the current row,
-- never a stale snapshot from before another concurrent writer's update.
-- ============================================================

CREATE OR REPLACE FUNCTION upsert_learned_rate(
  p_builder_id uuid,
  p_line_item_key text,
  p_rate numeric,
  p_unit text
) RETURNS void AS $$
BEGIN
  INSERT INTO builder_learned_rates (builder_id, line_item_key, rate, unit, sample_count, updated_at)
  VALUES (p_builder_id, p_line_item_key, p_rate, p_unit, 1, now())
  ON CONFLICT (builder_id, line_item_key) DO UPDATE SET
    rate = ROUND(
      ((builder_learned_rates.rate * builder_learned_rates.sample_count) + p_rate)
      / (builder_learned_rates.sample_count + 1),
      2
    ),
    sample_count = builder_learned_rates.sample_count + 1,
    unit = p_unit,
    updated_at = now();
END;
$$ LANGUAGE plpgsql;
