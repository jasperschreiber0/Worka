-- ============================================================
-- WorkA — Stage 3 wall-clock redesign: persist chunk-level progress
-- ============================================================
-- Context: production incident traced live (AI_RECOVERY_DISABLED's own
-- comment, and this session's diagnosis of a stalled batch) to a genuine
-- structural fact: WALL_CLOCK_SAFETY_MS (340s, smooth-responder/index.ts)
-- is LESS than 2 x STAGE3_PER_CALL_TIMEOUT_MS (440s) -- so a large project
-- whose fact base triggers trade chunking (>100 facts in the Stage 3
-- prompt) can never complete BOTH chunks in a single invocation, no matter
-- how little of the budget Stage 1/2 consumed first. The prior design
-- either ran the full 2-chunk plan or bailed with zero progress
-- (bailForWallClockBudget) -- meaning a chunked project could structurally
-- never finish Stage 3 in one shot, and every retry repeated both chunks
-- from scratch.
--
-- The fix (paired with planStage3Chunks in pipeline-logic.ts) computes how
-- many of the desired, right-sized chunks actually fit the CURRENT
-- invocation's remaining wall-clock budget, runs only those, and persists
-- which trade_category_ids were durably completed -- so the NEXT
-- invocation (a fresh wall-clock window) resumes with only the remaining
-- trades, never repeating already-done work and never starting a call that
-- can't finish.
--
-- Additive only. stage3_completed_trade_ids defaults to an empty array, so
-- every existing batch (and any code path that doesn't yet know about this
-- column) behaves exactly as before -- "no trades completed yet" is
-- indistinguishable from "this column didn't exist."
-- ============================================================

ALTER TABLE document_processing_batches
  ADD COLUMN IF NOT EXISTS stage3_completed_trade_ids integer[] NOT NULL DEFAULT '{}'::integer[];

COMMENT ON COLUMN document_processing_batches.stage3_completed_trade_ids IS
  'trade_category_ids whose Stage 3 scope reasoning has been durably completed (scope_items already upserted) for this batch, across possibly several invocations. Appended to after each successful chunk, read at the start of Stage 3 to compute the remaining trade list -- see planStage3Chunks in pipeline-logic.ts. Reset is never needed: once scope_reasoning_completed_at is set (all trades done, no blocking question), this column is frozen and irrelevant, matching the same lifecycle as scope_reasoning_completed_at itself (migration 053).';

NOTIFY pgrst, 'reload schema';
