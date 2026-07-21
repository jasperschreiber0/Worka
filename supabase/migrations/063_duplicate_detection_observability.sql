-- 063_duplicate_detection_observability.sql
-- Production validation pass for Phase 1 (migration 062): closes the
-- observability gaps found while auditing the deterministic duplicate-
-- detection flow end to end (upload -> content_hash -> duplicate lookup
-- -> extraction decision -> document status). No behaviour change to
-- detection itself — this only makes existing, already-happening outcomes
-- (a hash failure, a lookup failure, a file's byte size) durably queryable,
-- following the same narrow-column-on-files pattern already used for
-- failure_stage/failure_reason (migration 005) and
-- ai_failure_classification/ai_failure_count (migration 042).

ALTER TABLE files ADD COLUMN IF NOT EXISTS file_size_bytes bigint;

COMMENT ON COLUMN files.file_size_bytes IS
  'Raw byte length of the downloaded file, captured in document-worker/index.ts at the same point content_hash is computed (only when hashing itself succeeded). Not a general-purpose file-size column — its one consumer is document_duplicate_detection_summary()''s rough, explicitly-labelled token-savings estimate for detected duplicates (health_monitoring_views.sql). Null for files uploaded before this migration, or when hash computation failed.';

ALTER TABLE files ADD COLUMN IF NOT EXISTS content_hash_failed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN files.content_hash_failed IS
  'True if SHA-256 hash computation threw for this file (extremely rare — a crypto.subtle failure) — the fail-safe path already continues to normal extraction unaffected; this column exists only so that fallback is queryable rather than log-only. See files.content_hash''s own comment (migration 062) for the fail-safe contract this backs.';

ALTER TABLE files ADD COLUMN IF NOT EXISTS duplicate_lookup_failed boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN files.duplicate_lookup_failed IS
  'True if the candidate-files query (checking this file''s hash against earlier files in the same job) itself errored — distinct from content_hash_failed: the hash was computed successfully, only the lookup against prior files failed. This file''s own content_hash is still recorded even when this is true, so a LATER upload can still match against it. Fail-safe: normal extraction proceeds unaffected either way.';
