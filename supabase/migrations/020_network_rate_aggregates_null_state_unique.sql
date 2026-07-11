-- ============================================================
-- Close the NULL-state race on network_rate_aggregates
--
-- The existing UNIQUE (line_item_key, state) constraint (001_initial_schema)
-- does not stop duplicate rows for national aggregates (state IS NULL),
-- because standard SQL treats every NULL as distinct for uniqueness
-- purposes. The nightly network-rates cron worked around this with a
-- manual "select existing, then update-or-insert" sequence for national
-- rows — which is exactly the read-then-write pattern that races under
-- concurrent/overlapping cron runs.
--
-- Postgres 15+ supports NULLS NOT DISTINCT, which makes NULL participate
-- in uniqueness like any other value. Recreating the constraint this way
-- lets a single ON CONFLICT (line_item_key, state) upsert handle both
-- national and state-scoped rows atomically — no more manual branch.
-- ============================================================

ALTER TABLE network_rate_aggregates
  DROP CONSTRAINT IF EXISTS network_rate_aggregates_line_item_key_state_key;

ALTER TABLE network_rate_aggregates
  ADD CONSTRAINT network_rate_aggregates_line_item_key_state_key
  UNIQUE NULLS NOT DISTINCT (line_item_key, state);
