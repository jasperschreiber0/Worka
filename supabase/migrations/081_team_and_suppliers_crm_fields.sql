-- 081_team_and_suppliers_crm_fields.sql
-- Backend additions for the AI-native redesign's Team and Suppliers panels
-- (see the published interaction spec — "What genuinely requires backend
-- changes"). Two gaps closed here:
--
-- 1. `workers` had no rate/availability/markup columns at all — the Team
--    panel's spec calls for hourly rate, availability, and a default markup
--    per worker, none of which the schema captured (workers could previously
--    only be created via chat's free-text `add_worker` intent, which itself
--    never asked for these either). Additive, nullable/defaulted columns —
--    no existing row or query is affected.
--
-- 2. `suppliers` did not exist as an entity at all — only
--    `builder_supplier_rates` (an imported price list keyed by a free-text
--    `supplier_name` string) existed. This adds a real supplier record
--    (name, preferred trade, contact, pricing-agreement note) and a nullable
--    `supplier_id` FK on `builder_supplier_rates` so an existing imported
--    rate list can optionally be linked to a supplier record without being
--    forced to have one (a builder may still import a one-off rate sheet
--    with no corresponding supplier contact on file).

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS hourly_rate numeric(10,2),
  ADD COLUMN IF NOT EXISTS default_markup_pct numeric(5,4),
  ADD COLUMN IF NOT EXISTS available boolean NOT NULL DEFAULT true;

COMMENT ON COLUMN workers.hourly_rate IS 'Optional — set via the Team panel form. Nothing reads this for pricing yet; informational for the builder only until a future pass wires it into cost estimation.';
COMMENT ON COLUMN workers.default_markup_pct IS 'Optional per-worker default markup (0-1 fraction), set via the Team panel form. Not yet consumed by quote pricing (lib/pricing.ts) — same status as hourly_rate above.';
COMMENT ON COLUMN workers.available IS 'Builder-set availability toggle shown on the Team panel. Not derived from job_workers assignments or any schedule — a manual flag only.';

CREATE TABLE IF NOT EXISTS suppliers (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id                uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  name                      text        NOT NULL,
  preferred_trade_category_id integer   REFERENCES trade_categories(id),
  contact_name              text,
  contact_phone             text,
  contact_email             text,
  pricing_agreement_notes   text,
  created_at                timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE suppliers IS 'A builder''s supplier contacts — genuinely new entity (migration 081). Distinct from builder_supplier_rates, which is an imported price list keyed by a free-text supplier_name string; this table is the actual CRM record (contact info, preferred trade, agreement notes) a builder manages from the Suppliers panel.';

ALTER TABLE suppliers ENABLE ROW LEVEL SECURITY;

CREATE POLICY "suppliers_own_builder" ON suppliers
  FOR ALL USING (builder_id = auth.uid()) WITH CHECK (builder_id = auth.uid());

CREATE INDEX IF NOT EXISTS suppliers_builder_idx ON suppliers(builder_id, created_at DESC);

ALTER TABLE builder_supplier_rates
  ADD COLUMN IF NOT EXISTS supplier_id uuid REFERENCES suppliers(id) ON DELETE SET NULL;

COMMENT ON COLUMN builder_supplier_rates.supplier_id IS 'Optional link (migration 081) from an imported rate row to a real suppliers record. Nullable — an imported CSV rate sheet is not required to have a matching supplier contact on file.';

NOTIFY pgrst, 'reload schema';
