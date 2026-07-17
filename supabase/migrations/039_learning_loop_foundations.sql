-- Phase 2 learning-loop foundations (data capture only — no automatic
-- reconciliation trigger yet; see the production trust audit + learning-loop
-- audit for context). Two existing tables gain columns; no new tables.

-- A. Preserve what the AI/document originally said before a builder
-- correction overwrites quote_line_items, plus an optional reason for the
-- change. Written by POST /api/assumptions/[quoteId]/resolve at the moment
-- of resolution — the only mutation path for line items today.
alter table assumptions
  add column original_value jsonb null,
  add column resolution_note text null;

comment on column assumptions.original_value is
  'Snapshot of {quantity, unit, rate, total} from quote_line_items immediately before this resolution overwrote it. Null for resolutions recorded before this column existed.';
comment on column assumptions.resolution_note is
  'Optional free-text reason the builder gave when resolving — never required, never blocks the resolve action.';

-- B. Link variations back to the estimating taxonomy. Previously a
-- variation carried no trade/line-item linkage at all, making it dead-end
-- data for scope-gap learning despite being the real-world signal for
-- "the estimate under-scoped this."
alter table variations
  add column trade_category_id integer null references trade_categories(id),
  add column line_item_id uuid null references quote_line_items(id),
  add column origin_reason text null;

comment on column variations.trade_category_id is
  'Which trade this variation relates to, if known at creation time. Nullable — not every variation maps cleanly to one trade.';
comment on column variations.line_item_id is
  'The original quote_line_item this variation corrects/extends, if identifiable. Nullable.';
comment on column variations.origin_reason is
  'Free-text: why this variation exists (e.g. "scope missed", "client change", "site condition").';
