-- ============================================================
-- WorkA — Persisted project understanding (outside chat)
-- ============================================================
-- Context: the original project-memory ask included a standing project
-- confidence/completeness/missing-information surface, consumable by Job
-- Snapshot and Morning Brief, not just answerable on demand in chat. Phase
-- 1 (project_question) computed this only ephemerally, inside one chat
-- answer's prompt construction, discarded the instant the Claude call
-- returned — nothing persisted it anywhere a human or a cron job could
-- read without a chat message being sent first.
--
-- This is the lightest-weight fix available: three nullable columns on the
-- existing `jobs` row, not a new subsystem. lib/project-context.ts's
-- persistContext/persistProjectUnderstanding compute and write these —
-- opportunistically whenever chat answers a project_question, and once
-- automatically right after intake completes (app/api/intake/[fileId]/
-- route.ts) so the columns are populated even if nobody ever asks a chat
-- question about the job.
--
-- Deliberately NOT a new project_memory/project_understanding table: that
-- would be a second, driftable source of truth for data project_facts
-- already owns. These columns are a cached, denormalised VIEW of a
-- computation over project_facts/scope_items/clarifying_questions, not a
-- second copy of the facts themselves — safe to recompute and overwrite at
-- any time, never authoritative on their own.
-- ============================================================

ALTER TABLE jobs
  ADD COLUMN IF NOT EXISTS knowledge_confidence   numeric(5,2),
  ADD COLUMN IF NOT EXISTS knowledge_missing_count integer,
  ADD COLUMN IF NOT EXISTS knowledge_updated_at    timestamptz;

COMMENT ON COLUMN jobs.knowledge_confidence IS
  'Cached average confidence across this job''s active (non-superseded) project_facts, as last computed by lib/project-context.ts. NULL until at least one project_facts row exists for this job. Not authoritative — recomputed from project_facts on every chat project_question answer and after every intake completion, never written to directly.';

COMMENT ON COLUMN jobs.knowledge_missing_count IS
  'Cached count of open clarifying_questions for this job at the time knowledge_confidence was last computed.';

COMMENT ON COLUMN jobs.knowledge_updated_at IS
  'When knowledge_confidence/knowledge_missing_count were last recomputed. A stale timestamp (job has new documents processed since) is expected until the next chat question or intake run refreshes it — this is a cache, not a trigger-maintained value.';
