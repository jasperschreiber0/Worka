-- ============================================================
-- WorkA — Reasoning-First Estimating Engine, Migration 018
-- Consolidates the intake/estimation pipeline onto one schema:
--   Stage 1 Document Intelligence  -> project_documents
--   Stage 2 Project Understanding  -> project_facts
--   Stage 3 Scope Reasoning        -> scope_items
--   Stage 4/5 Gap Detection + Q&A  -> clarifying_questions
--   Stage 6 Quality Assurance      -> quotes.qa_report / overall_confidence
-- Also fixes the assumption "gate" (previously re-derived on every read
-- across four independent implementations) by persisting it once, at
-- write time, on the assumptions row.
-- ============================================================

-- ─── Assumptions: persist the gate that actually triggered ───

ALTER TABLE assumptions
  ADD COLUMN IF NOT EXISTS gate smallint CHECK (gate IN (1, 2, 3));

COMMENT ON COLUMN assumptions.gate IS
  'The validation gate that created this assumption (1 = no unit, 2 = quantity unverified from source, 3 = invalid quantity). Set once at extraction time — never re-derived from current line-item state.';

-- ─── files: new terminal status for blocking clarifying questions ───

ALTER TABLE files DROP CONSTRAINT IF EXISTS files_intake_status_check;
ALTER TABLE files ADD CONSTRAINT files_intake_status_check
  CHECK (intake_status IN ('uploaded', 'queued', 'processing', 'needs_info', 'extracted', 'failed'));

-- ─── Stage 1: Document Intelligence — the project document map ───

CREATE TABLE IF NOT EXISTS project_documents (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id            uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  file_id           uuid        NOT NULL REFERENCES files(id) ON DELETE CASCADE,
  document_type     text,       -- e.g. 'architectural_plan', 'structural_drawing', 'specification', 'photo'
  discipline        text,       -- e.g. 'architectural', 'structural', 'hydraulic', 'electrical'
  revision          text,
  issue_date        date,
  scale             text,
  page_count        int,
  drawing_title     text,
  readability       text        CHECK (readability IN ('clear', 'partial', 'poor')),
  ocr_quality       text        CHECK (ocr_quality IN ('good', 'degraded', 'unreadable')),
  trade_relevance   int[]       NOT NULL DEFAULT '{}',  -- trade_category_id[]
  is_duplicate      bool        NOT NULL DEFAULT false,
  duplicate_of_id   uuid        REFERENCES project_documents(id),
  is_superseded     bool        NOT NULL DEFAULT false,
  superseded_by_id  uuid        REFERENCES project_documents(id),
  notes             text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (file_id)
);

-- ─── Stage 2: Project Understanding — evidence-backed facts ───

CREATE TABLE IF NOT EXISTS project_facts (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  category            text        NOT NULL,   -- 'project_type' | 'building_type' | 'construction_method' | 'storeys' | 'rooms' | 'wet_areas' | 'kitchens' | 'laundries' | 'external_works' | 'structural_system' | 'finishes' | 'fixtures' | 'materials' | 'services' | 'trades_involved' | 'builder_answer'
  key                 text        NOT NULL,
  value               text        NOT NULL,
  source_document_id  uuid        REFERENCES project_documents(id),
  page_reference      text,
  evidence            text,       -- short supporting quote/observation
  -- 0-100. Facts sourced from a direct builder answer are always 100.
  confidence          numeric(5,2) NOT NULL DEFAULT 100,
  superseded          bool        NOT NULL DEFAULT false,
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- ─── Stage 3: Scope Reasoning — per-trade included/excluded scope ───

CREATE TABLE IF NOT EXISTS scope_items (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id              uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  trade_category_id   int         NOT NULL REFERENCES trade_categories(id),
  included_scope      text[]      NOT NULL DEFAULT '{}',
  excluded_scope      text[]      NOT NULL DEFAULT '{}',
  dependencies        text[]      NOT NULL DEFAULT '{}',
  assumptions         text[]      NOT NULL DEFAULT '{}',
  uncertainty_notes   text,
  -- 0-100
  confidence          numeric(5,2),
  created_at          timestamptz NOT NULL DEFAULT now(),
  UNIQUE (job_id, trade_category_id)
);

-- ─── Stage 4/5: Gap Detection -> Clarifying Questions ───

CREATE TABLE IF NOT EXISTS clarifying_questions (
  id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id        uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  question      text        NOT NULL,
  reason        text        NOT NULL,   -- why this materially affects the estimate
  trade_category_id int     REFERENCES trade_categories(id),
  -- blocking questions must be answered before Stage 5 (estimate generation) proceeds;
  -- non-blocking gaps are instead represented as per-line assumptions.
  blocking      bool        NOT NULL DEFAULT true,
  status        text        NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'answered', 'skipped')),
  answer        text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  answered_at   timestamptz
);

-- ─── Stage 6: Quality Assurance — persisted on the quote ───

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS qa_report jsonb,
  ADD COLUMN IF NOT EXISTS overall_confidence numeric(5,2);

COMMENT ON COLUMN quotes.qa_report IS
  'Stage 6 QA pass output: { top_risks: string[], review_items: string[], recommended_actions: string[], missing_trades: number[], duplicate_descriptions: string[] }. Computed after pricing, before render.';

-- ─── RLS ───

ALTER TABLE project_documents     ENABLE ROW LEVEL SECURITY;
ALTER TABLE project_facts         ENABLE ROW LEVEL SECURITY;
ALTER TABLE scope_items           ENABLE ROW LEVEL SECURITY;
ALTER TABLE clarifying_questions  ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_documents_own_builder" ON project_documents
  FOR ALL USING (job_id IN (SELECT id FROM jobs WHERE builder_id = auth.uid()));

CREATE POLICY "project_facts_own_builder" ON project_facts
  FOR ALL USING (job_id IN (SELECT id FROM jobs WHERE builder_id = auth.uid()));

CREATE POLICY "scope_items_own_builder" ON scope_items
  FOR ALL USING (job_id IN (SELECT id FROM jobs WHERE builder_id = auth.uid()));

CREATE POLICY "clarifying_questions_own_builder" ON clarifying_questions
  FOR ALL USING (job_id IN (SELECT id FROM jobs WHERE builder_id = auth.uid()));

-- ─── Indexes ───

CREATE INDEX IF NOT EXISTS project_documents_job_idx ON project_documents(job_id);
CREATE INDEX IF NOT EXISTS project_facts_job_idx ON project_facts(job_id) WHERE NOT superseded;
CREATE INDEX IF NOT EXISTS scope_items_job_idx ON scope_items(job_id);
CREATE INDEX IF NOT EXISTS clarifying_questions_job_idx ON clarifying_questions(job_id, status);
