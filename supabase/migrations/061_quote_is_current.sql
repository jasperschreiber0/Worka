-- ============================================================
-- WorkA — one active quote per job, database-enforced
-- ============================================================
-- Pre-first-estimate remediation, scoped deliberately narrow per the task
-- that requested it: NOT a fencing-token redesign, NOT a lock redesign —
-- just closing the one gap that could let a builder end up with two
-- "active" quotes for the same job with no schema-level guarantee against
-- it.
--
-- Root cause this closes: quote creation (supabase/functions/smooth-
-- responder/index.ts, and the Revise action, app/api/quotes/[quoteId]/
-- revise/route.ts) both do a plain SELECT-then-INSERT — "does this job
-- already have a draft/pending_review quote? if not, create one." That is
-- a read-then-write race with nothing in the schema preventing two
-- concurrent callers from both seeing no existing quote and both
-- inserting one. quote_line_items already has a unique index as a
-- backstop for line-item duplication (migration 030) — quotes itself has
-- had no equivalent.
--
-- Fix: quotes.is_current marks exactly one quote per job as "the" quote
-- every client-facing and builder-facing surface should read — enforced
-- by a partial unique index, not application convention. This does NOT
-- prevent two quotes rows from being inserted (that would need the lock/
-- fencing work explicitly out of scope for this pass) — it prevents two
-- of them from EVER both being current at once, which is the actual
-- guarantee a builder needs: at most one quote is ever "the" quote a
-- client could be sent. A second, accidental row from a genuine race
-- simply never becomes current and is inert.
-- ============================================================

ALTER TABLE quotes
  ADD COLUMN IF NOT EXISTS is_current boolean NOT NULL DEFAULT false;

-- Backfill: exactly one quote per job becomes current — the latest by
-- version (falling back to created_at, then id, for any pre-migration row
-- where version ties or is null). Every other quote for that job is left
-- false, which is correct: they are prior versions/superseded drafts, not
-- the current one.
WITH ranked AS (
  SELECT id,
         row_number() OVER (
           PARTITION BY job_id
           ORDER BY version DESC NULLS LAST, created_at DESC, id DESC
         ) AS rn
  FROM quotes
)
UPDATE quotes
SET is_current = true
FROM ranked
WHERE quotes.id = ranked.id
  AND ranked.rn = 1;

-- The actual guarantee: Postgres partial unique indexes only enforce
-- uniqueness among rows matching the WHERE clause, so any number of
-- is_current=false rows coexist freely — only a second is_current=true
-- row for the same job_id is rejected, atomically, by the database
-- itself, not by application logic that could race or be skipped.
CREATE UNIQUE INDEX IF NOT EXISTS quotes_one_current_per_job
  ON quotes (job_id)
  WHERE is_current;

COMMENT ON COLUMN quotes.is_current IS
  'Exactly one true per job_id, enforced by quotes_one_current_per_job (a partial unique index — the actual guarantee, not application convention). Set via the set_current_quote(job_id, quote_id) RPC whenever a new quote becomes the one to show a builder/client, never written directly. A second quote row created by a genuine race (see this migration''s header) simply never becomes current and is inert — this does not prevent the second row from being INSERTed, only from ever being treated as authoritative.';

-- ─── set_current_quote: atomic old→false / new→true transition ────────────
-- Single RPC call wraps both UPDATEs in one transaction (PostgREST already
-- wraps each RPC call in its own transaction) — no window where a job has
-- zero or two current quotes as observed by a concurrent reader. Idempotent:
-- calling it again for the same quote_id is a safe no-op.
CREATE OR REPLACE FUNCTION set_current_quote(p_job_id uuid, p_quote_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE quotes
  SET is_current = false
  WHERE job_id = p_job_id
    AND id != p_quote_id
    AND is_current = true;

  UPDATE quotes
  SET is_current = true
  WHERE id = p_quote_id
    AND job_id = p_job_id
    AND is_current = false;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION set_current_quote IS
  'Atomically marks quote p_quote_id as the current quote for p_job_id and un-marks any previous current quote for that job, in one transaction. The partial unique index quotes_one_current_per_job is what actually prevents two concurrent callers from both succeeding for the same job — this function is the correctness-preserving normal path, not the enforcement mechanism itself.';

NOTIFY pgrst, 'reload schema';
