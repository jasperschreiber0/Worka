-- ── 090: Stage 6 per-trade chunk checkpoint, mirroring migration 060's
--         stage3_completed_trade_ids ─────────────────────────────────────
--
-- Root cause this closes (from a read-only production-readiness audit):
-- Stage 6 (Estimate Generation) was the one remaining stage that asked
-- Claude for its ENTIRE output in one unchunked call -- every in-scope
-- trade's full line-item takeoff (typically 80-250 items) in a single
-- response. Unlike Stage 3, which was already redesigned (migration 060)
-- to chunk by trade and checkpoint progress so a large project converges
-- across multiple bounded invocations, a Stage 6 response that hits the
-- 16,000-token output ceiling (stop_reason: 'max_tokens') was thrown as an
-- error, classified by classifyAnthropicError's deliberately-conservative
-- 'unknown' bucket (never assume an unrecognised failure shape is safe to
-- retry), and permanently failed the whole estimate after one attempt --
-- retrying the identical full-scope request would only reproduce the
-- identical truncation. This is the one remaining case in the whole
-- pipeline where a legitimately large, real project could get
-- permanently stuck with no automatic recovery path.
--
-- Fix (application code, supabase/functions/smooth-responder/index.ts):
-- Stage 6 now processes trades in budget-aware chunks, exactly like Stage
-- 3 (reusing planStage3Chunks itself, not a parallel scheduling system),
-- persisting each chunk's line items and this checkpoint before moving to
-- the next chunk. A resumed invocation (via the same recovery mechanism
-- that already resumes a wall-clock-bailed Stage 6) only asks Claude for
-- the trades not yet in this array. A chunk that itself hits max_tokens is
-- split once and retried smaller (bounded — one extra split level, never
-- unbounded recursion) rather than failing the whole job; a single trade
-- that still can't fit is left for the existing post-hoc
-- findMissingTrades completeness-recovery pass, unchanged as the
-- secondary safety net it already was.
--
-- Additive only, safe for every existing row: defaults to an empty array,
-- so an already-complete batch (quote_id already set, every trade already
-- generated) is completely unaffected — the code path that reads this
-- column only ever runs before Stage 6 has produced a result, and a batch
-- past that point never revisits it.

ALTER TABLE document_processing_batches
  ADD COLUMN IF NOT EXISTS stage6_completed_trade_ids integer[] NOT NULL DEFAULT '{}'::integer[];

COMMENT ON COLUMN document_processing_batches.stage6_completed_trade_ids IS
  'Trade category IDs whose Stage 6 (Estimate Generation) line items have been durably persisted to quote_line_items for this batch. Mirrors stage3_completed_trade_ids (migration 060) exactly, one stage later: lets a Stage 6 run resumed in a fresh invocation (wall-clock bail, or the classification-retry recovery cron) skip straight to the trades not yet generated, instead of re-asking Claude for trades whose line items already exist. Updated after each successful chunk, not just once at the end — a crash mid-run never loses already-completed trades.';
