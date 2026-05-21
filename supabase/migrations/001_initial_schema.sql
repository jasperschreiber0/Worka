-- ============================================================
-- WorkA — Initial Schema Migration 001
-- AI Operations Manager for Australian Residential Builders
-- ============================================================
-- Idempotent: safe to run multiple times.
-- ============================================================

-- ─── Extensions ──────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";


-- ─── Core Entities ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS builders (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  email           text        UNIQUE NOT NULL,
  name            text        NOT NULL,
  business_name   text,
  abn             text,
  state           text        CHECK (state IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  plan            text        NOT NULL DEFAULT 'starter'
                              CHECK (plan IN ('starter','builder','business')),
  stripe_customer_id text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  role            text        NOT NULL,
  email           text,
  phone           text,
  status          text        NOT NULL DEFAULT 'invited'
                              CHECK (status IN ('invited','active','inactive')),
  invite_token    text        UNIQUE DEFAULT gen_random_uuid()::text,
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS clients (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  email           text,
  phone           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);


-- ─── Trade Categories (locked — never alter these 13 rows) ───

CREATE TABLE IF NOT EXISTS trade_categories (
  id              serial      PRIMARY KEY,
  sort_order      int         NOT NULL UNIQUE,
  name            text        NOT NULL UNIQUE,
  typical_line_items text[]   NOT NULL DEFAULT '{}'
);

INSERT INTO trade_categories (sort_order, name, typical_line_items) VALUES
  (1,  'Site Works & Concrete',  ARRAY['Excavation','Footings','Slab','Paths','Drainage']),
  (2,  'Framing',                ARRAY['Floor framing','Wall framing','Roof framing','Structural steel','LVL beams']),
  (3,  'Roofing',                ARRAY['Roof sheeting Colorbond','Roof sheeting tile','Flashings','Gutters','Downpipes']),
  (4,  'External Cladding',      ARRAY['Brick','Render','Weatherboard','Fibre cement','Timber cladding','Stone']),
  (5,  'Insulation',             ARRAY['Wall batts','Ceiling batts','Foil underlay','Sarking']),
  (6,  'Internal Linings',       ARRAY['Plasterboard walls','Plasterboard ceilings','Cornice','Set']),
  (7,  'Fit-out Carpentry',      ARRAY['Doors','Door hardware','Skirtings','Architraves','Shelving']),
  (8,  'Cabinetry',              ARRAY['Kitchen cabinetry','Laundry cabinetry','Vanities','Wardrobes','Linen']),
  (9,  'Paint',                  ARRAY['Internal walls','Internal ceilings','External paint','Feature walls']),
  (10, 'Flooring',               ARRAY['Tiles','Carpet','Timber flooring','Vinyl','Polished concrete']),
  (11, 'Fixtures & Tapware',     ARRAY['Toilets','Basins','Showers','Baths','Taps','Heated rails']),
  (12, 'Electrical',             ARRAY['GPOs','Switches','Lights','Data','Alarms','Switchboard']),
  (13, 'Preliminaries',          ARRAY['Permits','Council fees','Site costs','Insurance','Scaffolding'])
ON CONFLICT (sort_order) DO NOTHING;


-- ─── Jobs & Quotes ───────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jobs (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  client_id       uuid        REFERENCES clients(id),
  address         text        NOT NULL,
  status          text        NOT NULL DEFAULT 'quoting'
                              CHECK (status IN ('quoting','quoted','active','complete','archived')),
  job_type        text,
  notes           text,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION update_jobs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_jobs_updated_at ON jobs;
CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_jobs_updated_at();

CREATE TABLE IF NOT EXISTS quotes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','pending_review','sent','approved','rejected')),
  total_cost      numeric(12,2),
  margin_pct      numeric(5,2),
  confidence_score numeric(5,2),
  version         int         NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  approved_at     timestamptz
);

CREATE TABLE IF NOT EXISTS quote_line_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id            uuid        NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  trade_category_id   int         NOT NULL REFERENCES trade_categories(id),
  description         text        NOT NULL,
  quantity            numeric(10,3),
  unit                text,
  rate                numeric(12,2),
  total               numeric(12,2),
  confidence          numeric(5,2),
  dimensions_string   text,
  is_assumption       bool        NOT NULL DEFAULT false,
  assumption_status   text        CHECK (assumption_status IN ('unresolved','accepted','adjusted','excluded')),
  created_at          timestamptz NOT NULL DEFAULT now()
);


-- ─── 5-Tier Rate Hierarchy ────────────────────────────────────

CREATE TABLE IF NOT EXISTS cost_rates (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_category_id   int         NOT NULL REFERENCES trade_categories(id),
  line_item_key       text        NOT NULL,
  description         text        NOT NULL,
  unit                text        NOT NULL,
  rate                numeric(12,2) NOT NULL,
  state               text        CHECK (state IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  is_default          bool        NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (line_item_key, state)
);

CREATE TABLE IF NOT EXISTS builder_learned_rates (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  line_item_key   text        NOT NULL,
  rate            numeric(12,2) NOT NULL,
  unit            text        NOT NULL,
  sample_count    int         NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (builder_id, line_item_key)
);

CREATE TABLE IF NOT EXISTS builder_rate_preferences (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  line_item_key   text        NOT NULL,
  rate            numeric(12,2) NOT NULL,
  unit            text        NOT NULL,
  set_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (builder_id, line_item_key)
);

CREATE TABLE IF NOT EXISTS builder_supplier_rates (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  supplier_name   text        NOT NULL,
  line_item_key   text        NOT NULL,
  rate            numeric(12,2) NOT NULL,
  unit            text        NOT NULL,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (builder_id, supplier_name, line_item_key)
);

CREATE TABLE IF NOT EXISTS network_rate_aggregates (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  line_item_key   text        NOT NULL,
  state           text        CHECK (state IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  rate_p25        numeric(12,2),
  rate_p50        numeric(12,2),
  rate_p75        numeric(12,2),
  sample_count    int         NOT NULL DEFAULT 0,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (line_item_key, state)
);


-- ─── Variations & Invoices ────────────────────────────────────

CREATE TABLE IF NOT EXISTS variations (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  title           text        NOT NULL,
  description     text        NOT NULL,
  amount          numeric(12,2),
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','pending','approved','rejected')),
  created_at      timestamptz NOT NULL DEFAULT now(),
  approved_at     timestamptz,
  approved_by     text
);

CREATE TABLE IF NOT EXISTS invoices (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  amount          numeric(12,2) NOT NULL,
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','sent','overdue','paid')),
  due_date        date,
  sent_at         timestamptz,
  paid_at         timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now()
);


-- ─── Communications & Files ───────────────────────────────────

CREATE TABLE IF NOT EXISTS communication_history (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                uuid        REFERENCES jobs(id),
  builder_id            uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  direction             text        NOT NULL CHECK (direction IN ('inbound','outbound')),
  channel               text        NOT NULL CHECK (channel IN ('email','sms','chat')),
  subject               text,
  body                  text        NOT NULL,
  from_address          text,
  to_address            text,
  timestamp             timestamptz NOT NULL DEFAULT now(),
  linked_variation_id   uuid        REFERENCES variations(id),
  linked_invoice_id     uuid        REFERENCES invoices(id)
);

CREATE TABLE IF NOT EXISTS files (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid        REFERENCES jobs(id),
  quote_id        uuid        REFERENCES quotes(id),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  storage_path    text        NOT NULL,
  filename        text        NOT NULL,
  file_type       text        NOT NULL CHECK (file_type IN ('pdf','image','dwg','other')),
  intake_status   text        NOT NULL DEFAULT 'uploaded'
                              CHECK (intake_status IN ('uploaded','processing','extracted','failed')),
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS assumptions (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id        uuid        NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  line_item_id    uuid        REFERENCES quote_line_items(id),
  description     text        NOT NULL,
  resolution_type text        CHECK (resolution_type IN ('accepted','adjusted','excluded')),
  resolved_at     timestamptz,
  resolved_by     text,
  created_at      timestamptz NOT NULL DEFAULT now()
);


-- ─── Row Level Security ───────────────────────────────────────

ALTER TABLE builders              ENABLE ROW LEVEL SECURITY;
ALTER TABLE workers               ENABLE ROW LEVEL SECURITY;
ALTER TABLE clients               ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_categories      ENABLE ROW LEVEL SECURITY;
ALTER TABLE jobs                  ENABLE ROW LEVEL SECURITY;
ALTER TABLE quotes                ENABLE ROW LEVEL SECURITY;
ALTER TABLE quote_line_items      ENABLE ROW LEVEL SECURITY;
ALTER TABLE cost_rates            ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder_learned_rates ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder_rate_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE builder_supplier_rates   ENABLE ROW LEVEL SECURITY;
ALTER TABLE network_rate_aggregates  ENABLE ROW LEVEL SECURITY;
ALTER TABLE variations            ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices              ENABLE ROW LEVEL SECURITY;
ALTER TABLE communication_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE files                 ENABLE ROW LEVEL SECURITY;
ALTER TABLE assumptions           ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "builders_own"                    ON builders;
DROP POLICY IF EXISTS "workers_own_builder"             ON workers;
DROP POLICY IF EXISTS "clients_own_builder"             ON clients;
DROP POLICY IF EXISTS "trade_categories_read"           ON trade_categories;
DROP POLICY IF EXISTS "jobs_own_builder"                ON jobs;
DROP POLICY IF EXISTS "quotes_own_builder"              ON quotes;
DROP POLICY IF EXISTS "quote_line_items_own_builder"    ON quote_line_items;
DROP POLICY IF EXISTS "cost_rates_read"                 ON cost_rates;
DROP POLICY IF EXISTS "builder_learned_rates_own"       ON builder_learned_rates;
DROP POLICY IF EXISTS "builder_rate_preferences_own"    ON builder_rate_preferences;
DROP POLICY IF EXISTS "builder_supplier_rates_own"      ON builder_supplier_rates;
DROP POLICY IF EXISTS "network_rate_aggregates_read"    ON network_rate_aggregates;
DROP POLICY IF EXISTS "variations_own_builder"          ON variations;
DROP POLICY IF EXISTS "invoices_own_builder"            ON invoices;
DROP POLICY IF EXISTS "communication_history_own_builder" ON communication_history;
DROP POLICY IF EXISTS "files_own_builder"               ON files;
DROP POLICY IF EXISTS "assumptions_own_builder"         ON assumptions;

CREATE POLICY "builders_own" ON builders
  FOR ALL USING (id = auth.uid());

CREATE POLICY "workers_own_builder" ON workers
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "clients_own_builder" ON clients
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "trade_categories_read" ON trade_categories
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "jobs_own_builder" ON jobs
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "quotes_own_builder" ON quotes
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "quote_line_items_own_builder" ON quote_line_items
  FOR ALL USING (
    quote_id IN (
      SELECT id FROM quotes WHERE builder_id = auth.uid()
    )
  );

CREATE POLICY "cost_rates_read" ON cost_rates
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "builder_learned_rates_own" ON builder_learned_rates
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "builder_rate_preferences_own" ON builder_rate_preferences
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "builder_supplier_rates_own" ON builder_supplier_rates
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "network_rate_aggregates_read" ON network_rate_aggregates
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE POLICY "variations_own_builder" ON variations
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "invoices_own_builder" ON invoices
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "communication_history_own_builder" ON communication_history
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "files_own_builder" ON files
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "assumptions_own_builder" ON assumptions
  FOR ALL USING (
    quote_id IN (
      SELECT id FROM quotes WHERE builder_id = auth.uid()
    )
  );


-- ─── Indexes ─────────────────────────────────────────────────

CREATE INDEX IF NOT EXISTS idx_jobs_builder_status     ON jobs(builder_id, status);
CREATE INDEX IF NOT EXISTS idx_jobs_address            ON jobs(address);
CREATE INDEX IF NOT EXISTS idx_jobs_address_trgm       ON jobs USING gin(address gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_quotes_job_id           ON quotes(job_id);
CREATE INDEX IF NOT EXISTS idx_quotes_builder_status   ON quotes(builder_id, status);

CREATE INDEX IF NOT EXISTS idx_qli_quote_trade         ON quote_line_items(quote_id, trade_category_id);

CREATE INDEX IF NOT EXISTS idx_variations_job_status   ON variations(job_id, status);
CREATE INDEX IF NOT EXISTS idx_variations_builder      ON variations(builder_id, status);

CREATE INDEX IF NOT EXISTS idx_invoices_job_status     ON invoices(job_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_builder_status ON invoices(builder_id, status);
CREATE INDEX IF NOT EXISTS idx_invoices_due_date       ON invoices(due_date) WHERE status IN ('sent','overdue');

CREATE INDEX IF NOT EXISTS idx_comms_job_ts            ON communication_history(job_id, timestamp DESC);
CREATE INDEX IF NOT EXISTS idx_comms_builder_ts        ON communication_history(builder_id, timestamp DESC);

CREATE INDEX IF NOT EXISTS idx_blr_builder_key         ON builder_learned_rates(builder_id, line_item_key);
CREATE INDEX IF NOT EXISTS idx_brp_builder_key         ON builder_rate_preferences(builder_id, line_item_key);
CREATE INDEX IF NOT EXISTS idx_bsr_builder_key         ON builder_supplier_rates(builder_id, line_item_key);
CREATE INDEX IF NOT EXISTS idx_cost_rates_key_state    ON cost_rates(line_item_key, state);
CREATE INDEX IF NOT EXISTS idx_nra_key_state           ON network_rate_aggregates(line_item_key, state);

CREATE INDEX IF NOT EXISTS idx_workers_builder_status  ON workers(builder_id, status);
CREATE INDEX IF NOT EXISTS idx_files_builder_intake    ON files(builder_id, intake_status);
CREATE INDEX IF NOT EXISTS idx_files_job_id            ON files(job_id);
