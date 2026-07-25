-- 077_stage6_failure_protection_and_batch_ai_ceiling.sql
-- Response to a live, confirmed incident (2026-07-25, ~21:25-21:49 UTC):
-- two old batches (52 Bendio St, 99 Test St) were retried by the recovery
-- cron every ~60s continuously, calling Anthropic for stage_scope_reasoning
-- and stage_estimate_generation every single tick with no convergence.
--
-- ROOT CAUSE, traced and confirmed from code (not assumed): find_stuck_
-- batches_needing_classification_retry (migration 052) matches
-- document_processing_batches.status IN ('completed', 'completed_with_failures',
-- 'failed') AND classification_triggered = true AND no job_intake_locks row.
-- Its stated purpose is "classification_triggered flipped but smooth-responder
-- was never actually reached because the triggerClassification fetch was
-- lost." But status = 'failed' is ALSO exactly what smooth-responder's own
-- fail() sets when Stage 3 or Stage 6 genuinely runs, reaches Anthropic, and
-- permanently fails for a real, deterministic reason (a billing halt, or any
-- hard stop) — and fail()'s own try/finally releases job_intake_locks on
-- every exit path. So a batch that ALREADY ran and ALREADY failed
-- deterministically re-satisfies this query's criteria the moment the grace
-- period (3 min) elapses again, indistinguishable from a batch that never
-- reached smooth-responder at all. The recovery cron then re-triggers
-- smooth-responder for it, which (via the resumability checkpoints) skips
-- straight back to whichever stage failed, reproduces the identical
-- deterministic failure, calls fail() again, releases the lock again — and
-- the next cron tick matches the same criteria again. This is the loop.
--
-- Stage 3 already has an escalation counter that should stop this
-- (stage3_failure_classification/_count, migration 059) — but that counter
-- lives on document_processing_batches and is read/recorded INSIDE
-- smooth-responder's own Stage 3 code path. find_stuck_batches_needing_
-- classification_retry, which lives in the recovery cron and decides
-- whether to trigger ANOTHER invocation in the first place, never consulted
-- it — so even a batch already at (or past) its Stage 3 failure cap kept
-- being treated as a fresh "stuck, worth retrying" candidate by the cron,
-- and each retriggered invocation would itself correctly refuse to call
-- Anthropic again via shouldSkipStage3Call/record_stage3_failure's own
-- stop condition — EXCEPT this repeated observation could not be fully
-- confirmed live before the circuit breaker was manually tripped to stop
-- the incident; the safe fix implemented here closes the loop at its
-- source (the cron's own decision to retrigger at all) regardless of
-- whether that per-stage counter was also independently misbehaving, since
-- a batch already carrying ANY recorded stage3/stage6 failure is now
-- excluded from this "lost fetch" query outright — the two scenarios this
-- query conflated are now distinguishable directly in SQL: a genuine lost
-- fetch has classification_triggered=true but ZERO recorded stage3/stage6
-- failures (Anthropic was never even reached); a real deterministic
-- failure has a non-zero count and is Stage 3/6's own concern to escalate
-- from here, never the cron's to blindly retrigger.
--
-- Stage 6 (stage_estimate_generation) had NO equivalent escalation counter
-- at all before this migration — unlike Stage 1/2 (files.ai_failure_count,
-- migration 042/043) and Stage 3 (migration 059), a deterministic Stage 6
-- failure had nothing to stop it being retried by the recovery cron
-- indefinitely. This migration adds the Stage 6 analogue, mirroring
-- Stage 3's exact pattern (same columns shape, same RPC shape, same pure
-- shouldSkip/nextHistory functions in pipeline-logic.ts — see that file).
--
-- Finally, as a defense-in-depth backstop independent of any single
-- per-stage counter (in case one has its own bug, as this incident's
-- unresolved Stage-3 hash-stability question shows is possible), this
-- migration adds a hard, global ceiling on total Anthropic call attempts
-- per batch, checked once inside the ONE shared call site every stage in
-- this file already routes through (callTool, smooth-responder/index.ts) —
-- so it applies uniformly to Stage 1/2, Stage 3, Stage 6, and the Stage 6
-- trade-recovery loop without needing four separate implementations. If a
-- batch crosses this ceiling, the global AI circuit breaker (migration 054)
-- is tripped in the same transaction — a last-resort stop that does not
-- depend on any single stage's own escalation logic being correct.

-- ── Stage 6 failure escalation (mirrors migration 059's Stage 3 columns) ────
ALTER TABLE document_processing_batches
  ADD COLUMN IF NOT EXISTS stage6_failure_input_hash text,
  ADD COLUMN IF NOT EXISTS stage6_failure_classification text,
  ADD COLUMN IF NOT EXISTS stage6_failure_count integer NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS stage6_last_failure_at timestamptz;

COMMENT ON COLUMN document_processing_batches.stage6_failure_input_hash IS
  'SHA-256 hash (hashAiInput, ai-gateway.ts) of the exact Stage 6 estimate-generation prompt (facts + scope reasoning) that most recently failed for this batch. NULL until a Stage 6 call has failed at least once. Mirrors stage3_failure_input_hash (migration 059).';
COMMENT ON COLUMN document_processing_batches.stage6_failure_classification IS
  'classifyAnthropicError classification of the most recent Stage 6 failure for this batch. NULL until a failure has occurred. Mirrors stage3_failure_classification.';
COMMENT ON COLUMN document_processing_batches.stage6_failure_count IS
  'Consecutive occurrences of stage6_failure_classification for the SAME stage6_failure_input_hash. Reset to 1 whenever the input hash changes. Compared against maxConsecutiveOccurrences(classification) via shouldSkipStage6Call before the next Stage 6 attempt. Mirrors stage3_failure_count.';
COMMENT ON COLUMN document_processing_batches.stage6_last_failure_at IS
  'Timestamp of the most recent recorded Stage 6 failure — observability only, not itself part of the stop-condition logic (mirrors the fact that stage3 has no equivalent timestamp column, added here since it was explicitly requested and is cheap, useful context on how long a batch has been failing).';

CREATE OR REPLACE FUNCTION record_stage6_failure(
  p_batch_id uuid,
  p_input_hash text,
  p_classification text,
  p_max_occurrences int
)
RETURNS TABLE(classification text, occurrence_count int, stopped boolean) AS $$
DECLARE
  v_prior_input_hash text;
  v_prior_classification text;
  v_prior_count int;
  v_same_input boolean;
  v_next_count int;
  v_stop boolean;
BEGIN
  SELECT stage6_failure_input_hash, stage6_failure_classification, stage6_failure_count
  INTO v_prior_input_hash, v_prior_classification, v_prior_count
  FROM document_processing_batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN QUERY SELECT p_classification, 0, false;
    RETURN;
  END IF;

  v_same_input := (v_prior_input_hash IS NOT DISTINCT FROM p_input_hash)
                   AND (v_prior_classification IS NOT DISTINCT FROM p_classification);

  IF v_same_input THEN
    v_next_count := v_prior_count + 1;
  ELSE
    v_next_count := 1;
  END IF;

  v_stop := (p_max_occurrences <= 0) OR (v_same_input AND v_prior_count >= p_max_occurrences);

  UPDATE document_processing_batches
  SET stage6_failure_input_hash = p_input_hash,
      stage6_failure_classification = p_classification,
      stage6_failure_count = v_next_count,
      stage6_last_failure_at = now()
  WHERE id = p_batch_id;

  RETURN QUERY SELECT p_classification, v_next_count, v_stop;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION record_stage6_failure IS
  'Atomically records a Stage 6 (estimate generation) call failure against document_processing_batches.stage6_failure_input_hash/_classification/_count/_last_failure_at and decides, in the same transaction via SELECT...FOR UPDATE, whether to stop retrying this exact input. Mirrors record_stage3_failure (migration 059) exactly. p_max_occurrences mirrors maxConsecutiveOccurrences in pipeline-logic.ts; keep this function, that constant, and shouldSkipStage6Call/nextStage6FailureHistory in sync if any changes.';

-- ── Close the actual loop: exclude batches with ANY recorded stage3/stage6
-- failure from the "lost fetch, needs a blind retry" query. A batch with a
-- non-zero count definitely reached Anthropic at least once — the failure
-- is real and belongs to that stage's own escalation history, not this
-- generic recovery path's job to blindly retrigger.
CREATE OR REPLACE FUNCTION find_stuck_batches_needing_classification_retry(p_grace interval DEFAULT interval '3 minutes')
RETURNS TABLE(batch_id uuid, job_id uuid, builder_id uuid, primary_file_id uuid) AS $$
  SELECT b.id, b.job_id, b.builder_id, b.primary_file_id
  FROM document_processing_batches b
  WHERE b.status IN ('completed', 'completed_with_failures', 'failed')
    AND b.classification_triggered = true
    AND b.updated_at < now() - p_grace
    AND b.stage3_failure_count = 0
    AND b.stage6_failure_count = 0
    AND NOT EXISTS (SELECT 1 FROM job_intake_locks l WHERE l.job_id = b.job_id);
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION find_stuck_batches_needing_classification_retry IS
  'Batches whose document-processing finished and flipped classification_triggered, but no job_intake_locks row ever appeared for the job — evidence the triggerClassification fetch to smooth-responder was itself lost. Excludes any batch with stage3_failure_count > 0 OR stage6_failure_count > 0 (migration 077): a non-zero count proves Anthropic WAS reached and the failure is real and deterministic, not a lost fetch — retrying that is Stage 3/6''s own escalation logic''s job, never this generic cron path''s. This is the fix for the confirmed 2026-07-25 non-convergent retry incident, where a batch that had already failed deterministically kept re-matching this query forever because it conflated "never reached" with "reached and failed."';

-- ── Global, per-batch, cross-stage AI-call ceiling (defense in depth) ──────
-- Independent of any single stage's own escalation counter — a hard stop
-- that applies uniformly across Stage 1/2, Stage 3, Stage 6, and trade
-- recovery, checked from the one shared call site (callTool) all of them
-- already route through.
ALTER TABLE document_processing_batches
  ADD COLUMN IF NOT EXISTS total_ai_call_attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN document_processing_batches.total_ai_call_attempts IS
  'Total Anthropic call attempts across every stage (1/2, 3, 6, trade recovery) for this batch, incremented atomically by increment_batch_ai_attempts before each call. A defense-in-depth ceiling (migration 077) independent of any single stage''s own escalation counter — trips the global ai_circuit_breaker if crossed, regardless of which specific mechanism might have a bug.';

CREATE OR REPLACE FUNCTION increment_batch_ai_attempts(
  p_batch_id uuid,
  p_max_attempts int DEFAULT 20
)
RETURNS TABLE(attempts int, exceeded boolean) AS $$
DECLARE
  v_attempts int;
  v_exceeded boolean;
BEGIN
  UPDATE document_processing_batches
  SET total_ai_call_attempts = total_ai_call_attempts + 1
  WHERE id = p_batch_id
  RETURNING total_ai_call_attempts INTO v_attempts;

  IF NOT FOUND THEN
    -- Batch row doesn't exist (legacy direct-invocation path with no
    -- parentJobId, or a bad id) — nothing to gate on; caller proceeds.
    RETURN QUERY SELECT 0, false;
    RETURN;
  END IF;

  v_exceeded := v_attempts > p_max_attempts;

  IF v_exceeded THEN
    -- Same atomic auto-trip pattern record_ai_spend (migration 054) already
    -- uses — trips inside the same transaction as the crossing, not left to
    -- a JS caller that might die before acting on it.
    UPDATE system_status
    SET value = jsonb_build_object(
          'tripped', true,
          'reason', 'auto: batch ' || p_batch_id || ' exceeded ' || p_max_attempts || ' total AI call attempts (total_ai_call_attempts=' || v_attempts || ') — non-convergent retry suspected, see document_processing_batches for this batch'),
        updated_at = now()
    WHERE key = 'ai_circuit_breaker'
      AND (value->>'tripped')::boolean IS DISTINCT FROM true;
  END IF;

  RETURN QUERY SELECT v_attempts, v_exceeded;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION increment_batch_ai_attempts IS
  'Atomically increments document_processing_batches.total_ai_call_attempts and reports whether it has exceeded p_max_attempts, auto-tripping the global ai_circuit_breaker (migration 054) in the same transaction if so. Called from smooth-responder''s shared callTool before every Anthropic call, across every stage, as a defense-in-depth ceiling independent of any single stage''s own escalation counter.';

NOTIFY pgrst, 'reload schema';
