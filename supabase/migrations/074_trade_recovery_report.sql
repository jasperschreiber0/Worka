-- 074_trade_recovery_report.sql
-- Stage 6 completeness recovery (targeted regeneration for a scoped trade
-- Stage 6 generated zero line items for — confirmed on a real project:
-- Colorbond roofing/sarking/flashings/gutters/skylights/solar PV was scoped
-- by Stage 3 but never generated). Only smooth-responder (index.ts) knows
-- which trades were missing BEFORE recovery ran and which recovered — QA
-- (lib/estimating/qa.ts, migration 026's missing_trade_details) only ever
-- sees final state, so it can report "still missing" but not "was missing,
-- now fixed" on its own. This column is that missing before/after record,
-- written directly by smooth-responder alongside document_contribution
-- (migration 039) — same pattern, same file, same best-effort semantics.

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS trade_recovery_report jsonb;

COMMENT ON COLUMN quotes.trade_recovery_report IS
  'Stage 6 completeness recovery outcome: { initial_missing_trades: number[], recovered_trades: [{trade_category_id, items_generated}], remaining_missing_trades: number[] }. Null when no scoped trade was ever found missing for this quote. Written by supabase/functions/smooth-responder/index.ts; read (not written) by lib/estimating/qa.ts to surface alongside its own independently-derived missing_trade_details.';
