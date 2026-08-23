-- Read-only: decisive root-cause check for why enforce_estimate_deadlines()
-- has not finalized estimate_runs row 826ffcee-d1b7-45bf-8431-5630ba85d358
-- across 556+ successful route invocations since its deadline passed.
--
-- Prior evidence already gathered:
--   - pg_cron ticks every minute, "succeeded", for 9+ hours straight.
--   - intake_recovery_runs has a fresh row every minute in that window
--     (proves the Next.js route itself executed end-to-end, not just that
--     pg_net enqueued a request) -- rules out "route never reached".
--   - intake_recovery_runs.errors is [] for every row in the window --
--     rules out enforce_estimate_deadlines() throwing at the JS layer.
--   - The route calls supabase.rpc('enforce_estimate_deadlines') FIRST,
--     unconditionally, before either kill switch -- confirmed by direct
--     source read of app/api/cron/intake-recovery/route.ts.
--   - NOTE: intake_recovery_runs' own INSERT does NOT persist a
--     deadlines_enforced column at all (route.ts lines 967-982) -- it is
--     only in the JSON HTTP response and per-row logs, never in the DB
--     audit table. So "errors=[]" proves no exception, but does NOT prove
--     this row was actually matched/finalized by the RPC.
--
-- This narrows the remaining possibilities to: (C) the RPC runs clean but
-- its WHERE clause / FOR UPDATE SKIP LOCKED silently excludes this row, or
-- the LIVE function body differs from what's in the migration file, or
-- (D) something finalizes it and something else reverts it before the next
-- read. Checking both directly.

\echo '=== LIVE function body of enforce_estimate_deadlines() as deployed RIGHT NOW ==='
SELECT pg_get_functiondef('enforce_estimate_deadlines'::regproc);

\echo '=== Does the row match the RPC''s WHERE clause via a plain read RIGHT NOW (no FOR UPDATE) ==='
SELECT id, deadline_at, builder_status, (deadline_at < now()) AS deadline_passed, (builder_status IS NULL) AS status_null
FROM estimate_runs
WHERE id = '826ffcee-d1b7-45bf-8431-5630ba85d358';

\echo '=== Any lock currently held on this specific row or the estimate_runs relation, and by what session? ==='
SELECT l.locktype, l.mode, l.granted, l.pid,
       a.state, a.xact_start, a.query_start, now() - a.xact_start AS xact_age, a.query
FROM pg_locks l
JOIN pg_stat_activity a ON a.pid = l.pid
WHERE l.relation = 'estimate_runs'::regclass
   OR (l.locktype = 'tuple' AND l.relation = 'estimate_runs'::regclass);

\echo '=== Any long-idle-in-transaction sessions at all on this database (could hold row locks invisibly) ==='
SELECT pid, state, xact_start, now() - xact_start AS xact_age, query
FROM pg_stat_activity
WHERE state = 'idle in transaction'
  AND xact_start < now() - interval '5 minutes';

\echo '=== How many OTHER non-terminal estimate_runs rows exist right now (reconcile-sweep crowding context) ==='
SELECT count(*) AS non_terminal_count
FROM estimate_runs
WHERE status NOT IN ('complete', 'failed');

\echo '=== Does this row show up in the exact reconcile-sweep candidate query the route uses? ==='
SELECT batch_id FROM estimate_runs WHERE status NOT IN ('complete','failed') AND batch_id = 'bdeca4fa-4f36-4e95-b87a-4fb063724fde';

\echo '=== reconcile_estimate_run live function body (does it ever revert builder_status to NULL?) ==='
SELECT pg_get_functiondef('reconcile_estimate_run'::regproc);

\echo '=== compute_builder_status live function body (what would it return for this exact batch state) ==='
SELECT pg_get_functiondef('compute_builder_status'::regproc);

\echo '=== Direct dry-run: what would compute_builder_status(batch_id) return for this batch right now? ==='
SELECT * FROM compute_builder_status('bdeca4fa-4f36-4e95-b87a-4fb063724fde');

\echo '=== pg_net outbound HTTP response log around the deadline window (did the actual HTTP calls succeed, not just get enqueued?) ==='
SELECT id, status_code, created, (response_body::text) AS body_snippet
FROM net._http_response
WHERE created BETWEEN '2026-08-23 12:08:00+00' AND '2026-08-23 12:15:00+00'
ORDER BY created
LIMIT 20;

\echo '=== Financial safety re-confirm: ai_operations count/status for this job, unchanged since original check? ==='
SELECT count(*) AS total_ops, sum(cost_cents) AS total_cost_cents, max(created_at) AS last_call_at
FROM ai_operations
WHERE scope_key LIKE '89b77f76-7cb3-427d-ae81-919ea2320c35:%';

\echo '=== Financial safety: total_ai_call_attempts / stage6_active_calls right now ==='
SELECT total_ai_call_attempts, stage6_active_calls, updated_at
FROM document_processing_batches
WHERE id = 'bdeca4fa-4f36-4e95-b87a-4fb063724fde';

\echo '=== Financial safety: circuit breaker current state ==='
SELECT value FROM system_status WHERE key = 'ai_circuit_breaker';
