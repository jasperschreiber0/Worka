-- Read-only: confirm the exact FK/PK shape needed to safely clone a
-- disposable document_processing_batches + estimate_runs row pair for a
-- targeted watchdog verification (reusing the existing test job
-- 89b77f76-7cb3-427d-ae81-919ea2320c35), and confirm how to clean it up
-- afterward without violating any FK.

\echo '=== document_processing_batches PK/FKs ==='
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'document_processing_batches'::regclass;

\echo '=== estimate_runs PK/FKs (including any unique on batch_id) ==='
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'estimate_runs'::regclass;

\echo '=== estimate_run_events FK to estimate_runs (must be deleted before the parent row on cleanup) ==='
SELECT conname, contype, pg_get_constraintdef(oid)
FROM pg_constraint
WHERE conrelid = 'estimate_run_events'::regclass;

\echo '=== Baseline: current total ai_operations count for job 89b77f76 (must not change during the test) ==='
SELECT count(*) AS baseline_ops, sum(cost_cents) AS baseline_cost_cents
FROM ai_operations
WHERE scope_key LIKE '89b77f76-7cb3-427d-ae81-919ea2320c35:%';

\echo '=== Baseline: current time and next expected pg_cron tick ==='
SELECT now() AS db_now;
