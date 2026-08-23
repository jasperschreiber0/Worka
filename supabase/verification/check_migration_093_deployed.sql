-- Read-only: confirm migration 093's new objects actually exist and are
-- callable, and that the deployed reconcile_estimate_run picked up the
-- self-heal step.

\echo '=== New columns on quotes ==='
SELECT column_name, data_type, column_default
FROM information_schema.columns
WHERE table_name = 'quotes' AND column_name IN ('pricing_qa_backfill_attempts', 'pricing_qa_backfill_claimed_at');

\echo '=== claim_quote_for_pricing_qa_backfill callable? (bogus uuid, should return 0 rows, not error) ==='
SELECT * FROM claim_quote_for_pricing_qa_backfill('00000000-0000-0000-0000-000000000000'::uuid);

\echo '=== reconcile_estimate_run source contains the self-heal UPDATE (proves THIS deploy, not a stale cached body) ==='
SELECT prosrc LIKE '%Self-heal (migration 093)%' AS has_self_heal_step
FROM pg_proc WHERE proname = 'reconcile_estimate_run';

\echo '=== Grants on the new function ==='
SELECT p.proname, r.rolname AS grantee, has_function_privilege(r.oid, p.oid, 'EXECUTE') AS can_execute
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
CROSS JOIN pg_roles r
WHERE n.nspname = 'public' AND p.proname = 'claim_quote_for_pricing_qa_backfill'
  AND r.rolname IN ('anon', 'authenticated', 'service_role')
ORDER BY r.rolname;
