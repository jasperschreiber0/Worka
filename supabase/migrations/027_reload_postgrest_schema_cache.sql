-- ============================================================
-- Force a PostgREST schema cache reload.
--
-- Production has been seeing "Could not find the function
-- public.check_rate_limit(...) in the schema cache" (021) and 404s on
-- POST /rest/v1/project_documents (026) even though both the function and
-- the table are defined correctly in their migrations. PostgREST caches
-- the schema at startup/connection and does not always pick up DDL applied
-- via `supabase db push` without an explicit reload — this is a known
-- Supabase gotcha, not a bug in 021 or 026 themselves.
--
-- NOTIFY is idempotent and side-effect-free if the cache is already
-- current, so it's safe to ship as its own migration rather than backfill
-- it into 021/026 (which may have already run).
-- ============================================================

NOTIFY pgrst, 'reload schema';
