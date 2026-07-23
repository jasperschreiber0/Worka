-- 068_project_knowledge_model.sql
-- Phase 1 of the estimator rebuild (project-intelligence architecture,
-- reviewed 23 Jul 2026). Introduces a structured, derived cache over
-- project_facts — turning "678 facts tagged by category" into one JSON
-- object organised the way a trade actually needs to read it (foundations,
-- slab, framing, roof, ... instead of a flat confidence-ordered list).
--
-- Deliberately NOT a new source of truth: project_facts stays the evidence
-- ledger of record (source_document_id, page_reference, evidence,
-- confidence, superseded). project_models is a pure, mechanically
-- recomputed PROJECTION of it — the same "cached view, never authoritative,
-- recomputed and overwritten" pattern this codebase already uses for
-- jobs.knowledge_confidence (migration 035) and files.intake_status
-- (migration 052). It is built by a deterministic function
-- (buildProjectModel, pipeline-logic.ts) with NO additional Claude call —
-- Stage 1/2's own extraction schema already constrains project_facts.category
-- to a controlled enum, so bucketing by category (and then by a small,
-- explicit keyword map on each fact's key/value) is a pure transform.
--
-- Nothing reads this table yet. Populating it (this migration + the
-- write-through wiring in smooth-responder/index.ts) is Phase 1 only —
-- Stage 3/6 keep using the existing flat fact-selection path until a
-- single estimator has been benchmarked reading from this instead (see the
-- architecture review for why the multi-trade-agent split is deliberately
-- deferred past that benchmark).

CREATE TABLE IF NOT EXISTS project_models (
  job_id             uuid        PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,
  -- { summary: {...}, structure: {...}, external: {...}, internal: {...},
  --   services: {...}, site: {...}, unclassified: [...] } — see
  -- ProjectModelSections (pipeline-logic.ts) for the exact shape. Every leaf
  -- fact reference carries key/value/confidence/source_document_id/evidence
  -- — this reorganises project_facts, it never summarises or discards it.
  sections           jsonb       NOT NULL DEFAULT '{}'::jsonb,
  source_fact_count  integer     NOT NULL DEFAULT 0,
  model_version      integer     NOT NULL DEFAULT 1,
  derived_at         timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE project_models IS
  'Structured, derived cache over active project_facts, bucketed by trade-relevant section (structure/external/internal/services/site) rather than a flat confidence-ordered list. Pure projection — rebuilt and overwritten on every call to buildProjectModel, never written to directly, never authoritative on its own. See migration 068''s header comment.';

COMMENT ON COLUMN project_models.sections IS
  'ProjectModelSections shape (pipeline-logic.ts): summary scalars (project_type, storeys, floor_area, construction_method — best-fact picks) plus structure/external/internal/services/site, each holding arrays of full fact references (key, value, confidence, source_document_id, evidence). unclassified holds any active fact that matched no section keyword — nothing is silently dropped.';

COMMENT ON COLUMN project_models.source_fact_count IS
  'How many active (non-superseded) project_facts rows this model was derived from at build time — lets a consumer notice a stale model (source_fact_count far below the job''s current active fact count) without re-deriving to check.';

-- ─── trade_project_model_map ────────────────────────────────────────────────
-- Deterministic routing: which project_model section paths matter to each
-- of the 13 locked trade categories. Seed data, not AI output or a second
-- Claude call — this is the "concrete gets foundations, not paint colours"
-- rule from the spec, expressed as a lookup table so it is auditable and
-- editable without touching a prompt.
CREATE TABLE IF NOT EXISTS trade_project_model_map (
  trade_category_id  int   NOT NULL REFERENCES trade_categories(id),
  section_path       text  NOT NULL,   -- dot path into project_models.sections, e.g. 'structure.foundations'
  PRIMARY KEY (trade_category_id, section_path)
);

COMMENT ON TABLE trade_project_model_map IS
  'Deterministic map from trade_category_id to the project_models.sections paths relevant to that trade. Every trade also implicitly receives "summary". Seeded once below, editable directly — not derived from anything, not written to by the pipeline.';

INSERT INTO trade_project_model_map (trade_category_id, section_path) VALUES
  -- 1. Site Works & Concrete
  (1, 'site.slope'), (1, 'site.access'), (1, 'site.retaining'), (1, 'site.excavation'),
  (1, 'structure.foundations'), (1, 'structure.slab'),
  -- 2. Framing
  (2, 'structure.framing'), (2, 'structure.roof'),
  -- 3. Roofing
  (3, 'structure.roof'),
  -- 4. External Cladding
  (4, 'external.walls'), (4, 'external.cladding'),
  -- 5. Insulation
  (5, 'structure.framing'), (5, 'structure.roof'), (5, 'external.walls'),
  -- 6. Internal Linings
  (6, 'internal.flooring'), (6, 'internal.bathrooms'), (6, 'internal.kitchens'), (6, 'structure.framing'),
  -- 7. Fit-out Carpentry
  (7, 'internal.joinery'), (7, 'external.doors'),
  -- 8. Cabinetry
  (8, 'internal.kitchens'), (8, 'internal.joinery'), (8, 'internal.bathrooms'),
  -- 9. Paint
  (9, 'internal.flooring'), (9, 'internal.bathrooms'), (9, 'internal.kitchens'), (9, 'external.walls'),
  -- 10. Flooring
  (10, 'internal.flooring'),
  -- 11. Fixtures & Tapware
  (11, 'internal.bathrooms'), (11, 'internal.kitchens'), (11, 'services.hydraulic'),
  -- 12. Electrical
  (12, 'services.electrical'),
  -- 13. Preliminaries
  (13, 'site.access')
ON CONFLICT (trade_category_id, section_path) DO NOTHING;

-- ─── RLS ─────────────────────────────────────────────────────────────────────
ALTER TABLE project_models ENABLE ROW LEVEL SECURITY;
ALTER TABLE trade_project_model_map ENABLE ROW LEVEL SECURITY;

CREATE POLICY "project_models_own_builder" ON project_models
  FOR ALL USING (job_id IN (SELECT id FROM jobs WHERE builder_id = auth.uid()));

-- Read-only reference data for every authenticated user — same policy shape
-- as trade_categories itself (migration 001).
CREATE POLICY "trade_project_model_map_read" ON trade_project_model_map
  FOR SELECT USING (auth.role() = 'authenticated');

CREATE INDEX IF NOT EXISTS project_models_derived_at_idx ON project_models(derived_at);
