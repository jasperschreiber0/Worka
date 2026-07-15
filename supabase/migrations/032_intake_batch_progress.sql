-- ============================================================
-- WorkA — document processing pipeline fixes (silent file dropping +
-- timeout handling audit).
--
-- Adds per-batch progress columns so the multi-batch Stage 1/2 loop
-- (replacing the old single hard 20MB/6-sibling cutoff in
-- supabase/functions/smooth-responder) can report real progress like
-- "Classifying documents — batch 2 of 3" instead of one opaque stage that
-- looks identical whether it's processing 1 document or 15.
--
-- skipped_sibling_filenames / failed_sibling_filenames already exist
-- (migration 030) — no schema change needed there, only a write-timing fix
-- (write them as soon as batching decides which files are excluded,
-- not only once the whole run succeeds) made in the engine itself.
-- ============================================================

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS intake_batch_index int,
  ADD COLUMN IF NOT EXISTS intake_batch_count int;

COMMENT ON COLUMN files.intake_batch_index IS
  'Which document batch is currently being processed (1-based), when the run has more documents than fit in one Stage 1/2 Claude call. Null outside Stage 1/2 or for a single-batch run.';
COMMENT ON COLUMN files.intake_batch_count IS
  'Total number of document batches this run split into. Null outside Stage 1/2 or for a single-batch run.';
