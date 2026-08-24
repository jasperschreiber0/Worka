-- Cleanup for the Phase 1 (direct-SQL) synthetic row created by
-- check_direct_sql_test_row1.sql. Deletes the batch; cascades to
-- estimate_runs and estimate_run_events.

\echo '=== Deleting Phase 1 direct-SQL test batch ==='
DELETE FROM document_processing_batches WHERE id = 'd1c43844-5a2e-4ed6-9c15-28bdf7c995d8';

\echo '=== Confirm gone ==='
SELECT count(*) AS remaining FROM estimate_runs WHERE id = '3bd8ced9-5bc4-467d-9d81-4e7239aa7208';
