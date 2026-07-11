-- ============================================================
-- Close the duplicate-address race on job creation
--
-- createJob() (app/api/chat/route.ts) and the (unreachable, now-removed)
-- create-job edge function both did a check-then-insert: SELECT for an
-- existing similar address, then INSERT if none was found. Two concurrent
-- identical requests (double-click, a client retry after a slow response)
-- can both pass the SELECT before either INSERT lands, producing two rows
-- for the same address.
--
-- The application's duplicate check is intentionally fuzzy (first three
-- address tokens, so "12 Smith St" and "12 Smith Street, Fitzroy" are
-- treated as the same job) — a DB constraint can't encode that fuzziness.
-- This closes the exact-duplicate case (the one double-submits actually
-- produce) with a partial unique index; application code catches the
-- resulting unique-violation and re-queries to return the existing job
-- instead of erroring.
-- ============================================================

CREATE UNIQUE INDEX IF NOT EXISTS jobs_builder_address_unique_idx
  ON jobs (builder_id, lower(btrim(address)))
  WHERE status <> 'archived';
