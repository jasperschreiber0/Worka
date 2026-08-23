-- Cleanup: delete the disposable synthetic batch created for the targeted
-- watchdog verification. Cascades to estimate_runs (ON DELETE CASCADE)
-- and estimate_run_events (ON DELETE CASCADE from estimate_runs), per the
-- FK constraints confirmed in check_watchdog_verification_schema.sql.
DELETE FROM document_processing_batches
WHERE id = '6b5762c2-5593-4ca9-a1c2-bfe2ed90b3ee'
RETURNING id;
