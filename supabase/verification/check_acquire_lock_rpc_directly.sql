-- Read-only (wrapped in a rolled-back transaction): call
-- acquire_or_reclaim_job_intake_lock directly via SQL for the exact
-- job_id/file_id the recovery route would use, to see whether the SQL
-- logic itself succeeds. If it does, the bug is in how the Next.js route
-- invokes the RPC (PostgREST/supabase-js layer), not the SQL function.
-- Also checks the record_intake_recovery_attempt RPC the same way, and
-- prints the exact function signatures visible via pg_proc/PostgREST's
-- exposed schema, in case an overload or grant issue is the real cause.

BEGIN;

\echo '=== Direct call: acquire_or_reclaim_job_intake_lock for the stalled batch job/file ==='
SELECT * FROM acquire_or_reclaim_job_intake_lock(
  '21cbdd51-0bcd-4c1b-87db-fb39c1968330'::uuid,
  '1a8bd032-f710-4a4c-8956-667bc978969f'::uuid
);

\echo '=== job_intake_locks after the direct call (should now show 1 row if acquired) ==='
SELECT * FROM job_intake_locks WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330';

ROLLBACK;

\echo '=== Confirm rollback worked -- should be 0 rows again ==='
SELECT * FROM job_intake_locks WHERE job_id = '21cbdd51-0bcd-4c1b-87db-fb39c1968330';

\echo '=== Function grants -- does the anon/authenticated/service_role that PostgREST uses have EXECUTE? ==='
SELECT p.proname, r.rolname AS grantee, has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN pg_roles r
WHERE n.nspname = 'public'
  AND p.proname IN ('acquire_or_reclaim_job_intake_lock', 'record_intake_recovery_attempt', 'find_stuck_batches_needing_classification_retry')
  AND r.rolname IN ('anon', 'authenticated', 'service_role', 'postgres')
ORDER BY p.proname, r.rolname;

\echo '=== record_intake_recovery_attempt signature check (does the route call it with matching arg names/types?) ==='
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'record_intake_recovery_attempt';

\echo '=== acquire_or_reclaim_job_intake_lock signature ==='
SELECT p.proname, pg_get_function_identity_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE n.nspname = 'public' AND p.proname = 'acquire_or_reclaim_job_intake_lock';
