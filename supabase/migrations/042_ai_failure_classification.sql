-- 042_ai_failure_classification.sql
-- Per-file persisted history of Anthropic call failures, classified (see
-- classifyAnthropicError in supabase/functions/smooth-responder/pipeline-logic.ts),
-- so a LATER invocation (a resume, a fresh upload trigger, a recovery
-- reclaim) never blindly repeats an AI call already proven deterministic
-- for this exact file. Closes the "same document batch is later processed
-- again by recovery" half of a production incident where a batch that
-- timed out on every attempt kept being reprocessed identically, and a
-- `400 Your credit balance is too low` didn't stop the pipeline from
-- making more paid calls in the same run.
--
-- ai_failure_count tracks a STREAK of the same classification (see
-- nextFailureHistory, pipeline-logic.ts) — a different classification
-- resets it to 1, not accumulates. Once it reaches 2 (shouldStopRetrying),
-- the file is marked intake_status='failed' with a clear failure_reason at
-- the moment that happens (see recordAiFailure, index.ts), and is excluded
-- from being re-batched by any future invocation of this job.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS ai_failure_classification text,
  ADD COLUMN IF NOT EXISTS ai_failure_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN files.ai_failure_classification IS
  'Most recent Anthropic call failure classification for this file (classifyAnthropicError in pipeline-logic.ts) — e.g. application_timeout, credit_exhausted, context_window_exceeded. Null if no AI call has failed for this file, or its last attempt succeeded.';

COMMENT ON COLUMN files.ai_failure_count IS
  'Consecutive-failure streak for ai_failure_classification (resets to 1 on a different classification, per nextFailureHistory). At 2, the file is marked intake_status=failed and permanently excluded from future batching (shouldStopRetrying) — no third identical attempt is ever made.';

CREATE INDEX IF NOT EXISTS files_ai_failure_count_idx ON files (ai_failure_count)
  WHERE ai_failure_count > 0;
