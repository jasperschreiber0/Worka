-- Migration 014: builder's estimate fields
-- Complements 012 (pricing_type / cost splits / source_ref / per-line margin)
-- with pricing provenance + notes on line items, and quote-level contingency
-- and GST percentages so the estimate breakdown
-- (direct cost → contingency → margin → GST) is persisted.

ALTER TABLE quote_line_items
  ADD COLUMN IF NOT EXISTS pricing_basis text
    CHECK (pricing_basis IN ('measured', 'inferred', 'allowance')),
  ADD COLUMN IF NOT EXISTS notes text;

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS contingency_pct numeric(5,2) DEFAULT 8,
  ADD COLUMN IF NOT EXISTS gst_pct numeric(5,2) DEFAULT 10;
