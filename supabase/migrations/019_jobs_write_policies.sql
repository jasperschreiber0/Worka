-- ============================================================
-- Restore write-side RLS on `jobs`
--
-- 007_job_workers.sql dropped the original "jobs_own_builder" policy
-- (FOR ALL, i.e. SELECT+INSERT+UPDATE+DELETE) and replaced it with
-- "jobs_builder_or_assigned_worker", which is SELECT-only. No later
-- migration restored INSERT/UPDATE/DELETE coverage, so — with RLS enabled
-- and no matching policy — Postgres denies all writes to `jobs` for any
-- role other than the table owner/service role.
--
-- Every write path in the app happens to use the service-role key today
-- (which bypasses RLS), so this has been invisible in practice. But it
-- means tenant isolation for job writes currently rests entirely on
-- application code remembering to filter by builder_id — the database
-- itself enforces nothing. This restores that backstop.
-- ============================================================

CREATE POLICY "jobs_write_own_builder"
  ON jobs FOR INSERT
  WITH CHECK (builder_id = auth.uid());

CREATE POLICY "jobs_update_own_builder"
  ON jobs FOR UPDATE
  USING (builder_id = auth.uid())
  WITH CHECK (builder_id = auth.uid());

CREATE POLICY "jobs_delete_own_builder"
  ON jobs FOR DELETE
  USING (builder_id = auth.uid());
