-- ============================================================
-- WorkA — Stage 6 batch-level concurrency claim
-- ============================================================
-- Closes a gap found live during the post-fix production reliability test
-- (2026-08-23): STAGE6_MAX_PARALLEL_CHUNKS=2 (migration adding bounded
-- concurrency to Stage 6) only bounds concurrency WITHIN one smooth-responder
-- invocation's own Promise.allSettled — it does nothing to stop TWO separate
-- invocations of the same batch from each running their own pair of
-- concurrent chunks at the same time. This is a pre-existing, documented
-- characteristic of the pipeline (a reclaimed job_intake_lock does not kill
-- the physical old invocation still running server-side, and the recovery
-- cron's own retriggers can land while an earlier invocation's
-- EdgeRuntime.waitUntil work is still finishing) — Fix 2 just made the
-- consequence of it worse: what used to top out at 2 concurrent Stage 6
-- calls (1 per overlapping invocation) can now reach 4 (2 per invocation).
-- Confirmed directly in ai_operations timestamps: 4 stage_estimate_generation
-- calls for one job in flight simultaneously at 08:54:05-08:54:16 UTC.
--
-- The atomic 20-call-per-batch ceiling (increment_batch_ai_attempts,
-- migration 077) and the circuit breaker already make this financially safe
-- regardless of concurrency -- this migration is about respecting the
-- INTENDED invariant (<=2 Stage 6 calls in flight for a batch at any moment),
-- not about spend safety, which was never actually at risk.
--
-- Design: a TTL-based slot claim stored directly on document_processing_
-- batches (stage6_active_calls, a small JSONB array of {call_id, claimed_at}),
-- not a plain increment/decrement counter. A plain counter has no way to
-- self-heal if an invocation is killed uncleanly (Supabase's external
-- CPU-time governor kill bypasses try/finally, a well-documented risk
-- throughout this pipeline) -- it would leave the counter permanently
-- inflated, deadlocking Stage 6 for that batch forever. A TTL means a slot
-- claimed by a since-crashed invocation simply stops counting once
-- p_slot_ttl (240s -- STAGE6_PER_CALL_TIMEOUT_MS=220s plus a 20s margin, so
-- it can never expire while a genuinely still-running call could still
-- succeed) elapses, with no separate sweep/cron logic needed -- the next
-- claim attempt prunes it inline. This mirrors the same staleness-based
-- self-healing pattern job_intake_locks and document_processing_jobs
-- already use elsewhere in this pipeline, just scoped to Stage 6 slots.
--
-- claim_stage6_slot is called BEFORE any Anthropic call or AI-attempt
-- increment for a chunk (supabase/functions/smooth-responder/index.ts) --
-- a chunk that fails to claim never calls callTool, so it makes zero
-- Anthropic calls and never touches total_ai_call_attempts. It is left
-- unmarked-complete for this invocation exactly like any other deferred
-- chunk (a wall-clock defer, a truncation split) -- the NEXT invocation's
-- normal remainingTrades computation picks it up, no new retry loop.
-- release_stage6_slot is called in a try/finally around the Anthropic call,
-- so a normal completion (success OR a genuine thrown failure) always
-- releases promptly; only an uncatchable external kill leaves it to expire
-- via the TTL instead.
--
-- Uses SELECT ... FOR UPDATE (same idiom as record_ai_failure, migration
-- 043, and record_stage3_failure, migration 059) so two concurrent claim
-- attempts for the same batch are strictly serialized by Postgres's own row
-- lock, not racy application-side read-then-write.
-- ============================================================

ALTER TABLE document_processing_batches
  ADD COLUMN IF NOT EXISTS stage6_active_calls jsonb NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN document_processing_batches.stage6_active_calls IS
  'TTL-based slot claims for in-flight Stage 6 (Estimate Generation) Anthropic calls -- a small JSONB array of {call_id, claimed_at}, managed exclusively by claim_stage6_slot/release_stage6_slot (migration 094). A slot older than the claim RPC''s own p_slot_ttl (240s) is pruned inline on the next claim attempt and no longer counts -- self-healing against an invocation that never released cleanly (e.g. an external CPU-time governor kill), no separate cron sweep required. Enforces at most STAGE6_MAX_PARALLEL_CHUNKS (2) Stage 6 calls in flight for this batch at any moment, across however many smooth-responder invocations happen to overlap -- STAGE6_MAX_PARALLEL_CHUNKS itself only bounds concurrency within one invocation''s own Promise.allSettled.';

CREATE OR REPLACE FUNCTION claim_stage6_slot(
  p_batch_id uuid,
  p_max_concurrent int DEFAULT 2,
  p_slot_ttl interval DEFAULT interval '240 seconds'
)
RETURNS TABLE(claimed boolean, call_id uuid) AS $$
DECLARE
  v_slots jsonb;
  v_pruned jsonb;
  v_active_count int;
  v_call_id uuid;
BEGIN
  SELECT stage6_active_calls INTO v_slots
  FROM document_processing_batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Batch row doesn't exist (legacy no-batch direct-invocation path, or a
    -- bad id) -- nothing to gate concurrency on; caller proceeds unclaimed.
    -- Matches this pipeline's existing best-effort posture for every other
    -- batch-keyed RPC (record_ai_failure, record_stage3_failure, etc.).
    RETURN QUERY SELECT true, gen_random_uuid();
    RETURN;
  END IF;

  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
  INTO v_pruned
  FROM jsonb_array_elements(COALESCE(v_slots, '[]'::jsonb)) elem
  WHERE (elem->>'claimed_at')::timestamptz > now() - p_slot_ttl;

  v_active_count := jsonb_array_length(v_pruned);

  IF v_active_count >= p_max_concurrent THEN
    -- Persist the pruned (expired-slot-removed) array even on a refused
    -- claim, so an expired slot doesn't keep costing a jsonb scan on every
    -- future attempt once it's been observed as expired.
    UPDATE document_processing_batches SET stage6_active_calls = v_pruned WHERE id = p_batch_id;
    RETURN QUERY SELECT false, NULL::uuid;
    RETURN;
  END IF;

  v_call_id := gen_random_uuid();
  UPDATE document_processing_batches
  SET stage6_active_calls = v_pruned || jsonb_build_array(jsonb_build_object('call_id', v_call_id, 'claimed_at', now()))
  WHERE id = p_batch_id;

  RETURN QUERY SELECT true, v_call_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION claim_stage6_slot IS
  'Atomically claims one of at most p_max_concurrent (default 2) Stage 6 concurrency slots for a batch, pruning any slot older than p_slot_ttl (default 240s) first -- self-healing against a crashed holder without a separate sweep. Race-safe via SELECT...FOR UPDATE (mirrors record_ai_failure/record_stage3_failure). Returns claimed=false, call_id=NULL when no slot is available; the caller must not make an Anthropic call or increment AI attempts in that case, and must not retry within this same call -- it simply leaves that unit of work for a later invocation, exactly like any other deferred chunk.';

CREATE OR REPLACE FUNCTION release_stage6_slot(p_batch_id uuid, p_call_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE document_processing_batches
  SET stage6_active_calls = COALESCE(
    (SELECT jsonb_agg(elem) FROM jsonb_array_elements(stage6_active_calls) elem
     WHERE (elem->>'call_id')::uuid IS DISTINCT FROM p_call_id),
    '[]'::jsonb
  )
  WHERE id = p_batch_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION release_stage6_slot IS
  'Releases a previously claimed Stage 6 concurrency slot (claim_stage6_slot). Best-effort and idempotent -- releasing an already-released or expired-and-pruned call_id is a harmless no-op. Called from a try/finally around the Anthropic call in index.ts so a normal completion (success or a genuine thrown failure) always releases promptly; only an uncatchable external kill leaves the slot to expire via claim_stage6_slot''s own TTL instead.';

NOTIFY pgrst, 'reload schema';
