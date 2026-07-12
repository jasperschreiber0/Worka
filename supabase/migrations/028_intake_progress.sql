-- Track per-stage progress so the Next.js SSE poller can relay it to the UI
-- without holding an open Anthropic connection inside a Vercel serverless function.

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS intake_stage            text,
  ADD COLUMN IF NOT EXISTS intake_pct              integer,
  ADD COLUMN IF NOT EXISTS intake_assumption_count integer;
