-- 097_job_cost_entries.sql
-- Financials v1 — Live Job Money. Backs a live, per-job, incremental actual-
-- cost ledger — something that did not exist anywhere in the schema before
-- this migration. cost_reconciliation (migration 011) is NOT this table: it
-- is a one-row-per-trade snapshot taken at job close-out, keyed to
-- project_memory_id (the rate-learning loop), not job_id, and is not touched
-- by this migration or the feature it backs.
--
-- Modeled directly on `variations` (001_initial_schema.sql), the closest
-- existing precedent for a job-scoped money table: job_id + builder_id both
-- present and FK'd (builder_id carried directly rather than derived via a
-- join, so RLS stays a plain equality check like variations/invoices use),
-- amount as numeric(12,2), created_at timestamptz default now().
--
-- trade_category_id is nullable — not every real cost is trade-specific
-- (e.g. a council permit fee, a skip bin hire) — and deliberately has no
-- ON DELETE clause since trade_categories are the immutable, DB-locked 1-13
-- taxonomy (never deleted, so RESTRICT's default behavior is correct and
-- irrelevant in practice).
--
-- incurred_on is `date`, not `timestamptz`, matching invoices.due_date's
-- existing convention — a cost is logged against a day, not a moment.

CREATE TABLE job_cost_entries (
  id                 uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id             uuid          NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id         uuid          NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  trade_category_id  int           REFERENCES trade_categories(id),
  description        text          NOT NULL,
  amount             numeric(12,2) NOT NULL CHECK (amount >= 0),
  incurred_on        date          NOT NULL DEFAULT CURRENT_DATE,
  created_at         timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX ON job_cost_entries(job_id, incurred_on DESC);

ALTER TABLE job_cost_entries ENABLE ROW LEVEL SECURITY;

CREATE POLICY "job_cost_entries_own_builder" ON job_cost_entries
  FOR ALL USING (builder_id = auth.uid());
