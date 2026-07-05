-- ─── 018 Estimation reasoning layer ──────────────────────────────────────────
-- The inspectable "reason first, price later" stage (Stage 1). These tables hold
-- the auditable output of document intake + scope reasoning that precedes any
-- pricing: per-document classification/status, the project scope object, and the
-- essential open questions. Pricing continues to live on quotes/quote_line_items.

-- ── documents — one row per supplied project document ────────────────────────
-- Extends the existing `files` table (which stays the raw upload record); a
-- documents row is the reasoning layer's classification/quality view of a file.

create table if not exists public.documents (
  id                  uuid     primary key default gen_random_uuid(),
  builder_id          uuid     not null references public.builders(id) on delete cascade,
  job_id              uuid     references public.jobs(id) on delete cascade,
  file_id             uuid     references public.files(id) on delete set null,

  filename            text     not null,
  category            text     not null default 'other',
  -- architectural | structural | electrical | hydraulic | mechanical |
  -- joinery | finishes | survey | geotech | specification | other
  category_confidence integer  default 50,
  issue_status        text     default 'unknown',
  -- concept | da | da_modification | cc | cdc | ifc | draft | unknown
  document_date       text,               -- verbatim as shown on the document
  author              text,               -- practice from the title block (provenance only)

  extraction_status   text     not null default 'partial',   -- ok | partial | failed
  content_summary     text,
  unreadable_reason   text,               -- required when status is partial/failed
  raw_content         text,               -- extracted text layer (truncated), for audit

  created_at          timestamptz default now()
);

create index if not exists documents_job_idx     on public.documents(job_id);
create index if not exists documents_builder_idx on public.documents(builder_id);
create index if not exists documents_file_idx    on public.documents(file_id);

-- ── project_scope — one row per job (the scope object) ────────────────────────

create table if not exists public.project_scope (
  id                         uuid     primary key default gen_random_uuid(),
  builder_id                 uuid     not null references public.builders(id) on delete cascade,
  job_id                     uuid     references public.jobs(id) on delete cascade,

  project_type               text,
  scope_summary              jsonb    default '[]',   -- string[]
  site_data                  jsonb    default '{}',   -- SiteData
  room_scope                 jsonb    default '[]',   -- RoomScopeItem[]
  specialty_inclusions       jsonb    default '[]',   -- SpecialtyInclusion[]
  date_mismatches            jsonb    default '[]',   -- string[]

  complexity_rating          text,                    -- Low | Medium | High | Luxury
  complexity_justification   jsonb    default '[]',   -- string[] (evidence)

  recommended_estimate_type  text,                    -- Budget/Preliminary | Tender | Internal Costing
  estimate_type_justification text,

  trade_list                 jsonb    default '[]',   -- TradeJustification[]
  assumptions                jsonb    default '[]',   -- string[]
  risks                      jsonb    default '[]',   -- string[]
  exclusions                 jsonb    default '[]',   -- string[]

  -- when the clarifying-questions step is skipped, every downstream output is
  -- visibly labelled indicative (Stage 2 sets this).
  is_indicative              boolean  default true,

  created_at                 timestamptz default now(),
  updated_at                 timestamptz default now()
);

create unique index if not exists project_scope_job_id_idx on public.project_scope(job_id) where job_id is not null;
create index if not exists project_scope_builder_idx on public.project_scope(builder_id);

-- ── open_questions — essential clarifications before pricing ──────────────────

create table if not exists public.open_questions (
  id               uuid     primary key default gen_random_uuid(),
  builder_id       uuid     not null references public.builders(id) on delete cascade,
  job_id           uuid     references public.jobs(id) on delete cascade,

  question_group   text     not null,   -- missing_documents | drawing_annotations |
                                        -- unselected_finishes | commercial | output
  question_text    text     not null,
  source_reference text,                -- drawing/schedule ref, quoted not paraphrased
  resolved         boolean  default false,
  answer           text,

  created_at       timestamptz default now()
);

create index if not exists open_questions_job_idx     on public.open_questions(job_id);
create index if not exists open_questions_builder_idx on public.open_questions(builder_id);

-- ── RLS — builders access their own rows only ────────────────────────────────

alter table public.documents      enable row level security;
alter table public.project_scope  enable row level security;
alter table public.open_questions enable row level security;

create policy "builders access own documents"
  on public.documents for all
  using (builder_id = auth.uid());

create policy "builders access own project scope"
  on public.project_scope for all
  using (builder_id = auth.uid());

create policy "builders access own open questions"
  on public.open_questions for all
  using (builder_id = auth.uid());
