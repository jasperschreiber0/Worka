-- Migration 012: Quote data model upgrade
-- Adds cost split, pricing type, drawing reference, and per-line margin to quote_line_items

ALTER TABLE quote_line_items
  ADD COLUMN IF NOT EXISTS labour_cost       numeric(12,2),
  ADD COLUMN IF NOT EXISTS material_cost     numeric(12,2),
  ADD COLUMN IF NOT EXISTS subcontract_cost  numeric(12,2),
  ADD COLUMN IF NOT EXISTS plant_cost        numeric(12,2),
  ADD COLUMN IF NOT EXISTS pricing_type      text NOT NULL DEFAULT 'measured'
    CHECK (pricing_type IN ('measured', 'pc_allowance', 'provisional_sum')),
  ADD COLUMN IF NOT EXISTS source_ref        varchar(100),
  ADD COLUMN IF NOT EXISTS margin_pct        numeric(5,4) NOT NULL DEFAULT 0.15;

-- PS items get 0% margin by default — enforce via trigger so existing rows stay clean
CREATE OR REPLACE FUNCTION set_ps_margin_zero()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.pricing_type = 'provisional_sum' THEN
    NEW.margin_pct := 0;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_ps_margin ON quote_line_items;
CREATE TRIGGER trg_ps_margin
  BEFORE INSERT OR UPDATE ON quote_line_items
  FOR EACH ROW EXECUTE FUNCTION set_ps_margin_zero();

-- Index for PC/PS filtering
CREATE INDEX IF NOT EXISTS quote_line_items_pricing_type_idx ON quote_line_items(pricing_type)
  WHERE pricing_type IN ('pc_allowance', 'provisional_sum');
