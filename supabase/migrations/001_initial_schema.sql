-- ============================================================
-- WorkA — Initial Schema Migration 001
-- AI Operations Manager for Australian Residential Builders
-- ============================================================
-- Run order: extensions → core entities → trade categories →
--            jobs & quotes → rate hierarchy → variations &
--            invoices → communications & files → RLS → indexes
-- ============================================================

-- ─── Extensions ──────────────────────────────────────────────

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pg_trgm"; -- for address similarity search


-- ─── Core Entities ───────────────────────────────────────────

-- Builders (main user accounts — 1:1 with auth.users)
CREATE TABLE builders (
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

-- Workers (crew members linked to a builder)
CREATE TABLE workers (
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

-- Clients (home owners / developers)
CREATE TABLE clients (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  name            text        NOT NULL,
  email           text,
  phone           text,
  created_at      timestamptz NOT NULL DEFAULT now()
);


-- ─── Trade Categories (locked — never alter these 13 rows) ───

CREATE TABLE trade_categories (
  id              serial      PRIMARY KEY,
  sort_order      int         NOT NULL UNIQUE,
  name            text        NOT NULL UNIQUE,
  typical_line_items text[]   NOT NULL DEFAULT '{}'
);

-- Seed the 13 locked trade categories
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
  (13, 'Preliminaries',          ARRAY['Permits','Council fees','Site costs','Insurance','Scaffolding']);


-- ─── Jobs & Quotes ───────────────────────────────────────────

CREATE TABLE jobs (
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

-- Auto-update updated_at trigger
CREATE OR REPLACE FUNCTION update_jobs_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_jobs_updated_at
  BEFORE UPDATE ON jobs
  FOR EACH ROW EXECUTE FUNCTION update_jobs_updated_at();

CREATE TABLE quotes (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id          uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  status          text        NOT NULL DEFAULT 'draft'
                              CHECK (status IN ('draft','pending_review','sent','approved','rejected')),
  total_cost      numeric(12,2),
  margin_pct      numeric(5,2),
  -- Weighted toward the lowest line item confidence — the weakest link drives this score
  confidence_score numeric(5,2),
  version         int         NOT NULL DEFAULT 1,
  created_at      timestamptz NOT NULL DEFAULT now(),
  sent_at         timestamptz,
  approved_at     timestamptz
);

CREATE TABLE quote_line_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  quote_id            uuid        NOT NULL REFERENCES quotes(id) ON DELETE CASCADE,
  trade_category_id   int         NOT NULL REFERENCES trade_categories(id),
  description         text        NOT NULL,
  quantity            numeric(10,3),
  unit                text,
  rate                numeric(12,2),
  total               numeric(12,2),
  -- 0-100 per-line confidence score
  confidence          numeric(5,2),
  -- Plaintext dimensions string e.g. "12.5m × 8.4m"
  dimensions_string   text,
  is_assumption       bool        NOT NULL DEFAULT false,
  assumption_status   text        CHECK (assumption_status IN ('unresolved','accepted','adjusted','excluded')),
  created_at          timestamptz NOT NULL DEFAULT now()
);


-- ─── 5-Tier Rate Hierarchy ────────────────────────────────────
-- Priority (highest → lowest):
--   Tier 1: builder_learned_rates      — auto-captured from accepted quotes
--   Tier 2: builder_rate_preferences   — builder manually set
--   Tier 3: builder_supplier_rates     — imported supplier price lists
--   Tier 4: cost_rates                 — platform defaults (360+ items, seeded in 002)
--   Tier 5: network_rate_aggregates    — anonymised network median

-- Tier 4: Platform defaults (seeded in migration 002)
CREATE TABLE cost_rates (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  trade_category_id   int         NOT NULL REFERENCES trade_categories(id),
  line_item_key       text        NOT NULL,
  description         text        NOT NULL,
  unit                text        NOT NULL,
  rate                numeric(12,2) NOT NULL,
  -- null = national default, otherwise state-specific override
  state               text        CHECK (state IN ('NSW','VIC','QLD','WA','SA','TAS','ACT','NT')),
  is_default          bool        NOT NULL DEFAULT true,
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (line_item_key, state)
);

-- Tier 1: Builder's learned rates (auto-captured on quote acceptance)
CREATE TABLE builder_learned_rates (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  line_item_key   text        NOT NULL,
  rate            numeric(12,2) NOT NULL,
  unit            text        NOT NULL,
  sample_count    int         NOT NULL DEFAULT 1,
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (builder_id, line_item_key)
);

-- Tier 2: Builder's manually set rate preferences
CREATE TABLE builder_rate_preferences (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  line_item_key   text        NOT NULL,
  rate            numeric(12,2) NOT NULL,
  unit            text        NOT NULL,
  set_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (builder_id, line_item_key)
);

-- Tier 3: Supplier rate lists (imported PDFs / CSVs)
CREATE TABLE builder_supplier_rates (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  builder_id      uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  supplier_name   text        NOT NULL,
  line_item_key   text        NOT NULL,
  rate            numeric(12,2) NOT NULL,
  unit            text        NOT NULL,
  imported_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (builder_id, supplier_name, line_item_key)
);

-- Tier 5: Network aggregate rates (anonymised, computed nightly)
CREATE TABLE network_rate_aggregates (
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

CREATE TABLE variations (
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

CREATE TABLE invoices (
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

CREATE TABLE communication_history (
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

CREATE TABLE files (
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

CREATE TABLE assumptions (
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
-- Enable RLS on every table. Builders can only access their own data.
-- auth.uid() matches builders.id because we create the builder row
-- on sign-up with id = auth.uid().

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

-- builders: own row only
CREATE POLICY "builders_own" ON builders
  FOR ALL USING (id = auth.uid());

-- workers: only the owning builder
CREATE POLICY "workers_own_builder" ON workers
  FOR ALL USING (builder_id = auth.uid());

-- clients: only the owning builder
CREATE POLICY "clients_own_builder" ON clients
  FOR ALL USING (builder_id = auth.uid());

-- trade_categories: read-only for all authenticated users
CREATE POLICY "trade_categories_read" ON trade_categories
  FOR SELECT USING (auth.role() = 'authenticated');

-- jobs: only the owning builder
CREATE POLICY "jobs_own_builder" ON jobs
  FOR ALL USING (builder_id = auth.uid());

-- quotes: only the owning builder
CREATE POLICY "quotes_own_builder" ON quotes
  FOR ALL USING (builder_id = auth.uid());

-- quote_line_items: via quote ownership
CREATE POLICY "quote_line_items_own_builder" ON quote_line_items
  FOR ALL USING (
    quote_id IN (
      SELECT id FROM quotes WHERE builder_id = auth.uid()
    )
  );

-- cost_rates: read-only for authenticated users (platform data)
CREATE POLICY "cost_rates_read" ON cost_rates
  FOR SELECT USING (auth.role() = 'authenticated');

-- builder_learned_rates
CREATE POLICY "builder_learned_rates_own" ON builder_learned_rates
  FOR ALL USING (builder_id = auth.uid());

-- builder_rate_preferences
CREATE POLICY "builder_rate_preferences_own" ON builder_rate_preferences
  FOR ALL USING (builder_id = auth.uid());

-- builder_supplier_rates
CREATE POLICY "builder_supplier_rates_own" ON builder_supplier_rates
  FOR ALL USING (builder_id = auth.uid());

-- network_rate_aggregates: read-only (anonymised aggregate data)
CREATE POLICY "network_rate_aggregates_read" ON network_rate_aggregates
  FOR SELECT USING (auth.role() = 'authenticated');

-- variations
CREATE POLICY "variations_own_builder" ON variations
  FOR ALL USING (builder_id = auth.uid());

-- invoices
CREATE POLICY "invoices_own_builder" ON invoices
  FOR ALL USING (builder_id = auth.uid());

-- communication_history
CREATE POLICY "communication_history_own_builder" ON communication_history
  FOR ALL USING (builder_id = auth.uid());

-- files
CREATE POLICY "files_own_builder" ON files
  FOR ALL USING (builder_id = auth.uid());

-- assumptions: via quote ownership
CREATE POLICY "assumptions_own_builder" ON assumptions
  FOR ALL USING (
    quote_id IN (
      SELECT id FROM quotes WHERE builder_id = auth.uid()
    )
  );


-- ─── Indexes ─────────────────────────────────────────────────

-- jobs
CREATE INDEX ON jobs(builder_id, status);
CREATE INDEX ON jobs(address);                          -- duplicate address check
CREATE INDEX ON jobs USING gin(address gin_trgm_ops);  -- fuzzy address search

-- quotes
CREATE INDEX ON quotes(job_id);
CREATE INDEX ON quotes(builder_id, status);

-- quote_line_items
CREATE INDEX ON quote_line_items(quote_id, trade_category_id);

-- variations
CREATE INDEX ON variations(job_id, status);
CREATE INDEX ON variations(builder_id, status);

-- invoices
CREATE INDEX ON invoices(job_id, status);
CREATE INDEX ON invoices(builder_id, status);
CREATE INDEX ON invoices(due_date) WHERE status IN ('sent','overdue');

-- communication_history
CREATE INDEX ON communication_history(job_id, timestamp DESC);
CREATE INDEX ON communication_history(builder_id, timestamp DESC);

-- rate tables
CREATE INDEX ON builder_learned_rates(builder_id, line_item_key);
CREATE INDEX ON builder_rate_preferences(builder_id, line_item_key);
CREATE INDEX ON builder_supplier_rates(builder_id, line_item_key);
CREATE INDEX ON cost_rates(line_item_key, state);
CREATE INDEX ON network_rate_aggregates(line_item_key, state);

-- workers
CREATE INDEX ON workers(builder_id, status);

-- files
CREATE INDEX ON files(builder_id, intake_status);
CREATE INDEX ON files(job_id);
