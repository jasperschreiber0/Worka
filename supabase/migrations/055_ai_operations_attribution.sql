-- ─── 055: explicit attribution on the AI usage ledger ────────────────────────
--
-- Phase 0 completion: verification of migration 054 found three call sites
-- recording builder_id NULL not because the call was a system operation, but
-- because the identity wasn't threaded through a helper function — an
-- indistinguishable-from-system silent null. The gateway now requires an
-- explicit attribution on every call ({kind:'builder', builderId} or
-- {kind:'system', reason}), fails closed on anything malformed, and records
-- the kind here — so "who was this call for" is always answerable from the
-- ledger, and a NULL builder_id now provably means "declared system
-- operation", never "someone forgot".
--
-- Additive only. Existing rows backfill to 'builder' (every call site at the
-- time of 054 was builder-initiated; the three null-builder_id rows, if any
-- exist yet, predate enforcement and are identifiable by builder_id IS NULL
-- AND attribution = 'builder').

ALTER TABLE ai_operations
  ADD COLUMN attribution text NOT NULL DEFAULT 'builder'
    CHECK (attribution IN ('builder', 'system')),
  ADD COLUMN attribution_detail text;

COMMENT ON COLUMN ai_operations.attribution IS
  'Explicit attribution kind recorded by the AI gateway: ''builder'' (call made for an authenticated builder — builder_id set, per-builder limits applied) or ''system'' (declared system operation — attribution_detail states why, global limits only). The gateway refuses calls with missing/malformed attribution before any spend.';
COMMENT ON COLUMN ai_operations.attribution_detail IS
  'For attribution=''system'': the stated reason for the system operation. NULL for builder calls.';

NOTIFY pgrst, 'reload schema';
