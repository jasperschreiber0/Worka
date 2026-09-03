-- READ-ONLY. Backlog was never >1 batch (ruled out cap/starvation), circuit
-- breaker not tripped, AI_RECOVERY_DISABLED=false, lock empty throughout --
-- yet 6 real, genuinely-executed ticks (confirmed via net._http_response)
-- between 09:23 and 09:28 found zero stuck batches for one that was
-- clock-eligible (updated_at 09:19:32.552 + 3min grace = 09:22:32.552) the
-- whole time. First success landed at 09:29:00 -- ~9m27s after the stall,
-- not ~3m. This pulls the LIVE deployed function definition directly to
-- confirm the actual default p_grace value PostgREST is using, in case it
-- differs from the migration file. Zero writes.

\echo '=== live deployed function definition (exact default value) ==='
SELECT pg_get_functiondef('find_stuck_batches_needing_classification_retry'::regproc);

\echo '=== explicit call with p_grace=3min (matches route.ts no-arg call assumption) ==='
SELECT * FROM find_stuck_batches_needing_classification_retry(interval '3 minutes');

\echo '=== explicit call with NO arguments (relies on function default) ==='
SELECT * FROM find_stuck_batches_needing_classification_retry();

\echo '=== batch exact updated_at and now(), for precise elapsed-time math ==='
SELECT id, updated_at, now(), now() - updated_at AS elapsed
FROM document_processing_batches WHERE id = '9f14b072-5c91-4c0f-b238-adcef1a87fc8';

\echo '=== does the PostgREST-exposed RPC (via a raw call through pg_net-like path) differ? Check pg_proc args_default directly ==='
SELECT p.proname, pg_get_function_arguments(p.oid) AS args
FROM pg_proc p
JOIN pg_namespace n ON n.oid = p.pronamespace
WHERE p.proname = 'find_stuck_batches_needing_classification_retry' AND n.nspname = 'public';

\echo '=== now ==='
SELECT now();
