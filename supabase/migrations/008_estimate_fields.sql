-- ============================================================
-- WorkA — Migration 008: builder's estimate fields
-- Adds PC allowance / provisional sum classification and pricing
-- provenance to quote line items, plus contingency & GST
-- percentages on quotes so the estimate breakdown
-- (direct cost → contingency → margin → GST) is persisted.
-- ============================================================

ALTER TABLE quote_line_items
  ADD COLUMN IF NOT EXISTS item_type text
    CHECK (item_type IN ('measured', 'pc_allowance', 'provisional_sum'))
    DEFAULT 'measured';

ALTER TABLE quote_line_items
  ADD COLUMN IF NOT EXISTS pricing_basis text
    CHECK (pricing_basis IN ('measured', 'inferred', 'allowance'));

ALTER TABLE quote_line_items
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS contingency_pct numeric(5,2) DEFAULT 8;

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS gst_pct numeric(5,2) DEFAULT 10;
