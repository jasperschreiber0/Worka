-- ============================================================
-- WorkA — database-native scheduler for the intake recovery route
-- ============================================================
-- Context: app/api/cron/intake-recovery/route.ts (migration 037) is the
-- independent recovery service for the document-processing queue and the
-- job_intake_locks / classification-trigger gaps described there. Its only
-- production scheduler so far has been .github/workflows/intake-recovery-
-- cron.yml, a GitHub Actions `schedule:` trigger nominally set to run every
-- 5 minutes. Checked against real production run history: consecutive
-- fires were 55-90 minutes apart, not ~5 — GitHub's own scheduler queue is
-- best-effort and, for a low-traffic repo, degrades far past "a few
-- minutes' slip." Since recovery is the ONLY thing standing between a lost
-- triggerNext()/triggerClassification() fetch (document-worker/index.ts,
-- both fire-and-forget with a swallowed catch) and a permanently stuck
-- upload, a scheduler that's an hour late made recovery functionally
-- absent for anyone who didn't notice and manually re-fire the workflow —
-- exactly the incident this migration closes.
--
-- This adds pg_cron + pg_net — both first-party Supabase Postgres
-- extensions, no new infrastructure, no new service to deploy or pay for —
-- to call the SAME /api/cron/intake-recovery route from inside the
-- database itself, every minute, on a schedule Postgres runs directly
-- rather than depending on an external CI provider's own runner queue.
-- This is what makes the pipeline's forward progress genuinely independent
-- of triggerNext() succeeding: even if every single fire-and-forget call
-- in a batch is lost, the next pg_cron tick (at most ~60s away) finds the
-- claimable work and resumes it — no external scheduler, no manual
-- intervention, no dependency on any previous invocation still running.
--
-- The recovery ROUTE and its RPCs (migration 037) are UNCHANGED — this
-- migration only replaces WHAT CALLS IT, not what it does. Every RPC it
-- calls is already idempotent (FOR UPDATE SKIP LOCKED, atomic conditional
-- UPDATEs, or a re-verified acquire-or-reclaim), so running the route both
-- from pg_cron (every minute) and from the existing GitHub Actions
-- workflow (left in place as a redundant secondary trigger — same pattern
-- CLAUDE.md already documents for vercel.json's inert cron entries) is
-- harmless: whichever fires first does the work, the other finds nothing
-- left to do and returns all-zero counts.
--
-- ── Required one-time setup (NOT done by this migration, deliberately) ──
-- Secrets are never embedded in a committed migration file. pg_net's
-- headers reference Supabase Vault BY NAME, never by literal value — the
-- real URL/secret must be inserted once, out of band, via the Supabase SQL
-- editor (this is exactly the officially documented pattern — see
-- https://supabase.com/docs/guides/cron):
--
--   select vault.create_secret('https://worka-production.up.railway.app', 'worka_app_url');
--   select vault.create_secret('<the real CRON_SECRET value, matching Railway -> Variables>', 'worka_cron_secret');
--
-- Until both secrets exist, trigger_intake_recovery() logs a WARNING and
-- returns without attempting the call — it does not raise an exception
-- that would break the cron schedule itself, and does not spam a broken
-- request every minute. Once the two vault.create_secret calls above are
-- run, the very next scheduled tick (within 1 minute) starts working with
-- no further migration or deploy needed.
-- ============================================================

-- No WITH SCHEMA clause: both extensions' install scripts create their own
-- default schema (cron / net respectively) as part of installation: a
-- schema named in a bare CREATE EXTENSION's WITH SCHEMA clause must already
-- exist, but omitting the clause lets each extension provision its own
-- default schema itself. This mirrors the plain SQL Supabase's own Cron
-- docs show running directly from the SQL editor.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

CREATE OR REPLACE FUNCTION trigger_intake_recovery()
RETURNS void AS $$
DECLARE
  v_app_url text;
  v_cron_secret text;
BEGIN
  SELECT decrypted_secret INTO v_app_url
  FROM vault.decrypted_secrets WHERE name = 'worka_app_url' LIMIT 1;
  SELECT decrypted_secret INTO v_cron_secret
  FROM vault.decrypted_secrets WHERE name = 'worka_cron_secret' LIMIT 1;

  IF v_app_url IS NULL OR v_cron_secret IS NULL THEN
    RAISE WARNING 'trigger_intake_recovery: worka_app_url / worka_cron_secret not yet set in Vault — see migration 038 header comment for the one-time vault.create_secret setup. Skipping this tick.';
    RETURN;
  END IF;

  -- Fire-and-forget from Postgres's own perspective too (net.http_get just
  -- enqueues the request and returns immediately; the actual HTTP call and
  -- its response are handled asynchronously by pg_net's background worker,
  -- visible in net._http_response for diagnosis) — but unlike document-
  -- worker's in-process fire-and-forget, THIS one is called again
  -- unconditionally every 60 seconds regardless of whether the previous
  -- tick's request ever completed, so a single lost/slow request here
  -- cannot stall recovery the way a lost triggerNext() call could stall a
  -- whole document batch.
  PERFORM net.http_get(
    url := v_app_url || '/api/cron/intake-recovery',
    headers := jsonb_build_object('Authorization', 'Bearer ' || v_cron_secret),
    timeout_milliseconds := 30000
  );
END;
$$ LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog, public, vault, net;

COMMENT ON FUNCTION trigger_intake_recovery IS
  'Calls GET /api/cron/intake-recovery over HTTP via pg_net, using the app URL / CRON_SECRET stored in Supabase Vault (see migration 038 header for the one-time vault.create_secret setup). Scheduled every minute by pg_cron below — the database-native replacement for the GitHub Actions schedule, which was observed firing roughly hourly in production instead of every 5 minutes.';

-- Idempotent re-run: unschedule any previous job of this name before
-- scheduling, so re-applying this migration (or a future migration that
-- wants to change the interval) never ends up with two overlapping
-- schedules under the same name. cron.unschedule raises an error if the
-- name doesn't exist yet (first-ever run of this migration) — caught and
-- ignored rather than letting it fail the migration.
DO $$
BEGIN
  PERFORM cron.unschedule('worka-intake-recovery');
EXCEPTION WHEN OTHERS THEN
  NULL; -- no prior schedule under this name — nothing to unschedule
END $$;

SELECT cron.schedule(
  'worka-intake-recovery',
  '* * * * *', -- every minute — pg_cron's own minimum granularity, and far tighter than the ~5min GitHub Actions was nominally configured for (and the ~60min it was actually achieving in production)
  $$SELECT trigger_intake_recovery();$$
);

COMMENT ON EXTENSION pg_cron IS
  'Schedules trigger_intake_recovery() every minute (see the worka-intake-recovery job in cron.job). Database-native replacement for the GitHub Actions schedule that was found to be firing roughly hourly instead of every 5 minutes in production.';
