-- ─── Migration 011 — Estimation Memory Engine ──────────────────────────────
-- Adds project memory, cost reconciliation, subcategories, builder profiles,
-- and scope intelligence patterns.

-- Enable pgvector for future semantic retrieval
create extension if not exists vector;

-- ─── Trade subcategories (internal — users see parent category only) ─────────

create table if not exists public.trade_subcategories (
  id          uuid    primary key default gen_random_uuid(),
  trade_category_id integer not null references public.trade_categories(id),
  code        text    not null unique,  -- e.g. 'ELEC-SWITCHBOARD'
  name        text    not null,
  typical_unit text,
  sort_order  integer not null
);

comment on table public.trade_subcategories is
  'Internal subcategories for granular estimation learning. Never exposed in UI — parent trade_category is shown instead.';

insert into public.trade_subcategories (trade_category_id, code, name, typical_unit, sort_order) values
  -- 1 Earthworks & Site Prep
  (1, 'EARTH-CLEARING',   'Site clearing & demolition',       'm²',  10),
  (1, 'EARTH-EXCAVATION', 'Excavation & cut to fill',         'm³',  20),
  (1, 'EARTH-FILL',       'Fill, compact & level',            'm³',  30),
  (1, 'EARTH-DRAINAGE',   'Drainage & stormwater',            'lm',  40),
  (1, 'EARTH-FENCING',    'Temporary fencing & hoarding',     'lm',  50),
  (1, 'EARTH-ROCK',       'Rock breaking',                    'm³',  60),
  -- 2 Concrete
  (2, 'CONC-SLAB',        'Slab pour',                        'm²',  10),
  (2, 'CONC-FOOTING',     'Strip footings',                   'lm',  20),
  (2, 'CONC-RAFT',        'Raft slab',                        'm²',  30),
  (2, 'CONC-RETAINING',   'Retaining walls — concrete',       'm²',  40),
  (2, 'CONC-PATHS',       'Paths & driveways',                'm²',  50),
  (2, 'CONC-STAIRS',      'Concrete stairs',                  'ea',  60),
  -- 3 Framing & Structural
  (3, 'FRAME-WALL-PINE',  'Wall frames — pine',               'lm',  10),
  (3, 'FRAME-WALL-STEEL', 'Wall frames — steel',              'lm',  20),
  (3, 'FRAME-TRUSSES',    'Roof trusses',                     'ea',  30),
  (3, 'FRAME-FLOOR',      'Floor bearers & joists',           'm²',  40),
  (3, 'FRAME-LVL',        'LVL beams & lintels',              'lm',  50),
  (3, 'FRAME-STEEL',      'Structural steel',                 'kg',  60),
  -- 4 Roofing
  (4, 'ROOF-METAL',       'Roof cladding — metal/Colorbond',  'm²',  10),
  (4, 'ROOF-TILES',       'Roof cladding — tiles',            'm²',  20),
  (4, 'ROOF-GUTTERS',     'Gutters & downpipes',              'lm',  30),
  (4, 'ROOF-RIDGE',       'Ridge & hip capping',              'lm',  40),
  (4, 'ROOF-FASCIA',      'Fascia & barge boards',            'lm',  50),
  (4, 'ROOF-SKYLIGHT',    'Skylights',                        'ea',  60),
  -- 5 Windows & External Doors
  (5, 'WIND-ALUM',        'Aluminium windows',                'ea',  10),
  (5, 'WIND-TIMBER',      'Timber windows',                   'ea',  20),
  (5, 'WIND-ENTRY',       'Entry & pivot doors',              'ea',  30),
  (5, 'WIND-SLIDING',     'Sliding glass doors',              'ea',  40),
  (5, 'WIND-BIFOLD',      'Bi-fold doors',                    'ea',  50),
  (5, 'WIND-SCREENS',     'Fly screens & security',           'ea',  60),
  -- 6 External Cladding
  (6, 'CLAD-BRICK',       'Brick veneer',                     'm²',  10),
  (6, 'CLAD-WEATHER',     'Weatherboard & chamfer',           'm²',  20),
  (6, 'CLAD-RENDER',      'Rendered masonry',                 'm²',  30),
  (6, 'CLAD-FC',          'Compressed fibre cement sheet',    'm²',  40),
  (6, 'CLAD-BATTEN',      'Batten screens & feature',         'm²',  50),
  (6, 'CLAD-ALUCO',       'Alucobond & aluminium panels',     'm²',  60),
  -- 7 Insulation
  (7, 'INSU-CEIL',        'Ceiling batts',                    'm²',  10),
  (7, 'INSU-WALL',        'Wall batts',                       'm²',  20),
  (7, 'INSU-SLAB',        'Under-slab insulation',            'm²',  30),
  (7, 'INSU-ACOUSTIC',    'Acoustic insulation',              'm²',  40),
  (7, 'INSU-SARKING',     'Reflective foil sarking',          'm²',  50),
  (7, 'INSU-RIGID',       'Rigid foam board',                 'm²',  60),
  -- 8 Internal Linings
  (8, 'LINING-WALLS',     'Plasterboard walls',               'm²',  10),
  (8, 'LINING-CEIL',      'Plasterboard ceiling',             'm²',  20),
  (8, 'LINING-SET',       'Set plaster & cornices',           'lm',  30),
  (8, 'LINING-VILLA',     'Villaboard wet areas',             'm²',  40),
  (8, 'LINING-FIRE',      'Fire-rated plasterboard',          'm²',  50),
  (8, 'LINING-SHADOW',    'Shadowline & bulkheads',           'lm',  60),
  -- 9 Joinery & Cabinetry
  (9, 'JOIN-KITCHEN',     'Kitchen cabinetry',                'ea',  10),
  (9, 'JOIN-VANITY',      'Bathroom vanity',                  'ea',  20),
  (9, 'JOIN-LAUNDRY',     'Laundry cabinet',                  'ea',  30),
  (9, 'JOIN-ROBE',        'Built-in wardrobes',               'lm',  40),
  (9, 'JOIN-LINEN',       'Linen press',                      'ea',  50),
  (9, 'JOIN-PANTRY',      'Pantry & butler\'s',               'ea',  60),
  -- 10 Painting
  (10, 'PAINT-INT-WALL',  'Interior walls',                   'm²',  10),
  (10, 'PAINT-INT-CEIL',  'Interior ceilings',                'm²',  20),
  (10, 'PAINT-EXT',       'Exterior walls',                   'm²',  30),
  (10, 'PAINT-TRIM',      'Doors & trims',                    'm²',  40),
  (10, 'PAINT-GARAGE',    'Garage floor sealer',              'm²',  50),
  (10, 'PAINT-FEATURE',   'Feature wall treatment',           'm²',  60),
  -- 11 Plumbing
  (11, 'PLUMB-ROUGH',     'Rough-in',                         'ea',  10),
  (11, 'PLUMB-FIX',       'Fixtures & tapware',               'ea',  20),
  (11, 'PLUMB-HWS',       'Hot water system',                 'ea',  30),
  (11, 'PLUMB-DRAIN',     'Drainage & sewer',                 'lm',  40),
  (11, 'PLUMB-STORM',     'Stormwater',                       'lm',  50),
  (11, 'PLUMB-GAS',       'Gas rough-in',                     'lm',  60),
  -- 12 Electrical
  (12, 'ELEC-BOARD',      'Switchboard',                      'ea',  10),
  (12, 'ELEC-POWER',      'Power points & circuits',          'ea',  20),
  (12, 'ELEC-DATA',       'Data & communications',            'ea',  30),
  (12, 'ELEC-LIGHT',      'Lighting — LED downlights',        'ea',  40),
  (12, 'ELEC-FANS',       'Ceiling fans',                     'ea',  50),
  (12, 'ELEC-SMOKE',      'Smoke alarms & safety',            'ea',  60),
  (12, 'ELEC-EV',         'EV charger',                       'ea',  70),
  -- 13 Tiling & Finishes
  (13, 'TILE-FLOOR',      'Floor tiles',                      'm²',  10),
  (13, 'TILE-WALL',       'Wall tiles',                       'm²',  20),
  (13, 'TILE-SPLASH',     'Splashback',                       'm²',  30),
  (13, 'TILE-STONE',      'Stone benchtops',                  'lm',  40),
  (13, 'TILE-TIMBER',     'Timber flooring',                  'm²',  50),
  (13, 'TILE-CARPET',     'Carpet',                           'm²',  60),
  (13, 'TILE-HYBRID',     'Hybrid / vinyl plank flooring',    'm²',  70),
  (13, 'TILE-POLISHED',   'Polished concrete',                'm²',  80);

-- ─── Project memory (one record per completed / active job) ───────────────────

create table if not exists public.project_memory (
  id                 uuid     primary key default gen_random_uuid(),
  builder_id         uuid     not null references public.builders(id) on delete cascade,
  job_id             uuid     references public.jobs(id) on delete set null,
  quote_id           uuid     references public.quotes(id) on delete set null,

  -- Structured metadata for similarity matching
  project_summary    text,
  job_type           text,        -- rear_extension | bathroom_reno | kitchen_reno | new_build | knockdown_rebuild | double_storey | granny_flat | renovation
  renovation_type    text,        -- extension | renovation | new_build | addition | alteration
  floor_area_m2      numeric,
  storeys            integer,
  wet_areas          integer,
  bedrooms           integer,
  finish_level       text,        -- budget | standard | premium | luxury
  construction_type  text,        -- timber_frame | steel_frame | double_brick | brick_veneer
  region             text,        -- NSW | VIC | QLD | SA | WA | TAS | ACT | NT
  suburb             text,

  -- Financial outcomes
  quoted_cost        numeric,
  final_cost         numeric,
  quoted_margin_pct  numeric,
  final_margin_pct   numeric,

  -- Trade cost breakdown { "1": { "estimated": 12000, "actual": 14500 }, ... }
  trade_breakdown    jsonb default '{}',

  -- Scope intelligence: items suggested vs items actually required
  scope_hits         jsonb default '[]',  -- scope hints that proved correct
  scope_misses       jsonb default '[]',  -- scope hints that were rejected

  -- Vector embedding (nullable — populated when embedding service is wired up)
  embedding          vector(1536),

  status             text     default 'draft',   -- draft | quoted | active | completed
  created_at         timestamptz default now(),
  completed_at       timestamptz
);

create index if not exists project_memory_builder_idx on public.project_memory(builder_id);
create index if not exists project_memory_job_type_idx on public.project_memory(job_type);
create index if not exists project_memory_region_idx   on public.project_memory(region);

-- ─── Cost reconciliation (estimated vs actual per trade per project) ──────────

create table if not exists public.cost_reconciliation (
  id                   uuid    primary key default gen_random_uuid(),
  project_memory_id    uuid    not null references public.project_memory(id) on delete cascade,
  builder_id           uuid    not null references public.builders(id),
  trade_category_id    integer not null references public.trade_categories(id),

  estimated_cost       numeric not null,
  actual_cost          numeric,
  variance_amount      numeric generated always as (actual_cost - estimated_cost) stored,

  job_type             text,
  region               text,
  finish_level         text,

  recorded_at          timestamptz,
  created_at           timestamptz default now()
);

create index if not exists cost_recon_builder_idx  on public.cost_reconciliation(builder_id);
create index if not exists cost_recon_trade_idx    on public.cost_reconciliation(trade_category_id);

-- ─── Builder estimation profiles ──────────────────────────────────────────────

create table if not exists public.builder_estimation_profiles (
  id                      uuid    primary key default gen_random_uuid(),
  builder_id              uuid    not null references public.builders(id) on delete cascade unique,

  -- Pricing behaviour
  typical_margin_pct      numeric default 20,
  typical_contingency_pct numeric default 5,
  typical_labour_loading  numeric default 0,
  finish_level            text    default 'standard',

  -- Adjustment behaviour
  avg_adjustment_pct      numeric,   -- positive = builder increases AI quotes
  adjustment_direction    text,      -- 'increase' | 'decrease' | 'neutral'

  -- Variation patterns
  avg_variations_per_job  numeric,
  avg_variation_value     numeric,

  -- Accuracy metrics
  quotes_generated        integer default 0,
  jobs_completed          integer default 0,
  avg_quote_accuracy_pct  numeric,   -- how close estimated was to final cost

  -- Preferred suppliers (JSON array)
  preferred_suppliers     jsonb default '[]',

  updated_at              timestamptz default now()
);

-- ─── Scope intelligence patterns ──────────────────────────────────────────────

create table if not exists public.scope_intelligence_patterns (
  id               uuid    primary key default gen_random_uuid(),
  renovation_type  text,
  trigger_keywords text[]  default '{}',
  likely_items     jsonb   not null default '[]',  -- [{ description, trade_category_id, confidence, typical_cost_range, reason }]
  created_at       timestamptz default now()
);

-- Seed with known patterns
insert into public.scope_intelligence_patterns (renovation_type, trigger_keywords, likely_items) values
(
  'extension',
  array['rear extension', 'addition', 'extension'],
  '[
    {"description": "Demolition of existing rear wall & weatherproofing", "trade_category_id": 1, "confidence": 90, "reason": "All extensions require opening the existing structure"},
    {"description": "Temporary weather protection during works", "trade_category_id": 1, "confidence": 85, "reason": "Required while structure is open"},
    {"description": "Existing drainage relocation", "trade_category_id": 11, "confidence": 75, "reason": "Commonly impacted by extension footprint"},
    {"description": "Structural tie-in to existing building", "trade_category_id": 3, "confidence": 88, "reason": "New structure must connect to existing"},
    {"description": "Material matching to existing facade", "trade_category_id": 6, "confidence": 70, "reason": "Client usually requires visual continuity"}
  ]'
),
(
  'bathroom_reno',
  array['bathroom', 'ensuite', 'wet area', 'bath'],
  '[
    {"description": "Full waterproofing membrane — floor & walls 1800mm", "trade_category_id": 2, "confidence": 98, "reason": "Required by BCA for all wet areas"},
    {"description": "Tile removal & substrate prep", "trade_category_id": 1, "confidence": 90, "reason": "Existing tiles must be removed before waterproofing"},
    {"description": "Floor drainage adjustment to new layout", "trade_category_id": 11, "confidence": 80, "reason": "Drain position may change with new layout"},
    {"description": "Floor height build-up", "trade_category_id": 8, "confidence": 65, "reason": "Tile + adhesive + substrate can raise floor 40-60mm"}
  ]'
),
(
  'kitchen_reno',
  array['kitchen', 'kitchen renovation', 'kitchen reno'],
  '[
    {"description": "Plumbing rough-in changes", "trade_category_id": 11, "confidence": 85, "reason": "Sink & dishwasher positions commonly move"},
    {"description": "Additional electrical circuits", "trade_category_id": 12, "confidence": 88, "reason": "Modern kitchens require dedicated circuits for appliances"},
    {"description": "Rangehood ducting", "trade_category_id": 12, "confidence": 80, "reason": "External ducting needed unless recirculating"},
    {"description": "Floor level adjustment at kickboard", "trade_category_id": 8, "confidence": 60, "reason": "New flooring height may differ at cabinet base"}
  ]'
),
(
  'double_storey',
  array['double storey', 'second storey', 'upper level', 'first floor addition'],
  '[
    {"description": "Structural engineering fees", "trade_category_id": 1, "confidence": 98, "reason": "Mandatory for second storey additions"},
    {"description": "Existing structure strengthening / underpinning", "trade_category_id": 3, "confidence": 78, "reason": "Footings often need upgrade for additional load"},
    {"description": "Stair construction", "trade_category_id": 3, "confidence": 95, "reason": "Access stair always required"},
    {"description": "Party wall / neighbour notification", "trade_category_id": 1, "confidence": 70, "reason": "Most councils require neighbour notification for second storey"}
  ]'
),
(
  'renovation',
  array['occupied renovation', 'occupied', 'owner occupied', 'live in'],
  '[
    {"description": "Dust & site protection for occupied areas", "trade_category_id": 1, "confidence": 88, "reason": "Required when client remains on site"},
    {"description": "After-hours or staged work allowance", "trade_category_id": 1, "confidence": 72, "reason": "Noise restrictions may limit work hours"},
    {"description": "Temporary kitchen or bathroom facilities", "trade_category_id": 11, "confidence": 65, "reason": "Client needs alternative while wet areas are out"}
  ]'
);

-- ─── RLS ──────────────────────────────────────────────────────────────────────

alter table public.project_memory           enable row level security;
alter table public.cost_reconciliation      enable row level security;
alter table public.builder_estimation_profiles enable row level security;

create policy "builders access own project memory"
  on public.project_memory for all
  using (builder_id = auth.uid());

create policy "builders access own reconciliation"
  on public.cost_reconciliation for all
  using (builder_id = auth.uid());

create policy "builders access own profile"
  on public.builder_estimation_profiles for all
  using (builder_id = auth.uid());

-- Subcategories and scope patterns are public read
create policy "subcategories public read"
  on public.trade_subcategories for select
  using (true);

create policy "scope patterns public read"
  on public.scope_intelligence_patterns for select
  using (true);
