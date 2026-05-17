-- ─── Migration 006: RBAC + human-readable references ──────────────────────────

-- ─── 1a. Add permission_role to workers ──────────────────────────────────────

ALTER TABLE workers
  ADD COLUMN IF NOT EXISTS permission_role text NOT NULL DEFAULT 'tradesperson'
  CHECK (permission_role IN ('owner', 'site_manager', 'subcontractor', 'tradesperson'));

-- Update seeded workers to sensible roles
UPDATE workers SET permission_role = 'site_manager'   WHERE id = '00000000-0000-0000-0000-000000000002'; -- Tom Chen, carpenter
UPDATE workers SET permission_role = 'subcontractor'  WHERE id = '00000000-0000-0000-0000-000000000003'; -- Maria Santos, plumber
UPDATE workers SET permission_role = 'tradesperson'   WHERE id = '00000000-0000-0000-0000-000000000004'; -- James O'Brien, painter

-- ─── 1b. Human-readable reference columns ─────────────────────────────────────

ALTER TABLE jobs       ADD COLUMN IF NOT EXISTS job_ref       text UNIQUE;
ALTER TABLE quotes     ADD COLUMN IF NOT EXISTS quote_ref     text UNIQUE;
ALTER TABLE variations ADD COLUMN IF NOT EXISTS variation_ref text;
ALTER TABLE variations ADD COLUMN IF NOT EXISTS labour_cost   numeric(12,2);
ALTER TABLE variations ADD COLUMN IF NOT EXISTS materials_cost numeric(12,2);
ALTER TABLE variations ADD COLUMN IF NOT EXISTS submitted_by  text;

-- Unique constraint on (job_id, variation_ref) so refs are unique per job
ALTER TABLE variations
  ADD CONSTRAINT variations_job_id_variation_ref_unique
  UNIQUE (job_id, variation_ref);

-- ─── 1c. Auto-generate job_ref on insert ──────────────────────────────────────

CREATE OR REPLACE FUNCTION generate_job_ref()
RETURNS TRIGGER AS $$
DECLARE
  seq_num int;
  yr text;
BEGIN
  yr := to_char(NOW(), 'YYYY');
  SELECT COUNT(*) + 1 INTO seq_num
  FROM jobs
  WHERE builder_id = NEW.builder_id
    AND EXTRACT(YEAR FROM created_at) = EXTRACT(YEAR FROM NOW());
  NEW.job_ref := 'JOB-' || yr || '-' || LPAD(seq_num::text, 3, '0');
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_job_ref
  BEFORE INSERT ON jobs
  FOR EACH ROW
  WHEN (NEW.job_ref IS NULL)
  EXECUTE FUNCTION generate_job_ref();

-- ─── 1d. Seed fixed job_refs for existing jobs ────────────────────────────────

UPDATE jobs SET job_ref = 'JOB-2025-001' WHERE id = '00000000-0000-0000-0000-000000000010';
UPDATE jobs SET job_ref = 'JOB-2025-002' WHERE id = '00000000-0000-0000-0000-000000000011';
UPDATE jobs SET job_ref = 'JOB-2025-003' WHERE id = '00000000-0000-0000-0000-000000000012';

-- Seed quote_refs
UPDATE quotes SET quote_ref = 'QT-JOB-2025-002-v1' WHERE job_id = '00000000-0000-0000-0000-000000000011';
UPDATE quotes SET quote_ref = 'QT-JOB-2025-003-v1' WHERE job_id = '00000000-0000-0000-0000-000000000012';

-- Seed variation data
UPDATE variations SET
  variation_ref  = 'VAR-001',
  labour_cost    = 800,
  materials_cost = 2400,
  submitted_by   = 'Tom Chen'
WHERE title ILIKE '%benchtop%';

UPDATE variations SET
  variation_ref  = 'VAR-002',
  labour_cost    = 680,
  materials_cost = 0,
  submitted_by   = 'Tom Chen'
WHERE title ILIKE '%GPO%';

-- ─── 1e. RLS policies for role-based access ───────────────────────────────────

-- Comment explaining subcontractor isolation status
COMMENT ON TABLE workers IS 'permission_role controls UI-level access. Full row-level subcontractor isolation requires job_workers junction table (TODO).';

-- Re-enable RLS (it should already be on, but make sure)
ALTER TABLE workers ENABLE ROW LEVEL SECURITY;

-- Drop old select policy if it exists (replace with new one)
DROP POLICY IF EXISTS "workers_view_own_builder_workers" ON workers;

-- Workers can see their own builder's workers list
CREATE POLICY "workers_view_own_builder_workers"
  ON workers FOR SELECT
  USING (builder_id = auth.uid() OR id = auth.uid());
