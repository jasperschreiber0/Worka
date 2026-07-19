-- ============================================================
-- WorkA — Stage 3 (Scope Reasoning) failure-escalation identity
-- ============================================================
-- Context: investigation into a production Stage 3 application_timeout
-- incident (see CLAUDE.md "Anthropic failure classification" and the
-- follow-up analysis) found that files.ai_failure_count (migration 042) —
-- Stage 1/2's per-file retry-escalation counter — is the WRONG identity for
-- Stage 3's own retries. Stage 3 doesn't operate on any single file; it
-- reasons over the job's whole MERGED project_facts base in one call. Using
-- files.id to key Stage 3's failure history means a builder who re-uploads
-- the exact same problematic document set gets a brand new files.id, silently
-- resetting the counter to zero and repeating the identical doomed
-- timeout-then-fail cycle indefinitely — real, wasted Anthropic spend each
-- time, with no convergence.
--
-- The correct identity is Stage 3's actual input: which
-- document_processing_batches row (already the natural checkpoint home for
-- Stage 3 state — see scope_reasoning_completed_at, migration 053), plus a
-- content hash of the exact prompt sent (the same SHA-256-of-prompt-parts
-- approach ai-gateway.ts's hashAiInput already uses for idempotent reuse —
-- reused here, not reinvented).
--
-- record_stage3_failure mirrors record_ai_failure (migration 043) exactly —
-- same atomic SELECT...FOR UPDATE pattern, same v_stop boundary semantics
-- (compares the count BEFORE this failure to p_max_occurrences) — with one
-- addition: the streak only continues when BOTH the input hash AND the
-- classification match the prior recorded failure. A genuinely different
-- input (new/removed documents changing the merged fact base -> different
-- hash) always resets to a fresh count of 1, regardless of what classification
-- it produces, satisfying "genuinely changed document sets get a fresh
-- attempt allowance." Keep in sync with maxConsecutiveOccurrences and
-- shouldSkipStage3Call/nextStage3FailureHistory in pipeline-logic.ts if any
-- of the three changes.
--
-- Stage 1/2's own files.ai_failure_count / record_ai_failure are completely
-- unchanged by this migration — this is an ADDITIONAL, independent
-- escalation axis for Stage 3 specifically, not a replacement.
-- ============================================================

ALTER TABLE document_processing_batches
  ADD COLUMN IF NOT EXISTS stage3_failure_input_hash text,
  ADD COLUMN IF NOT EXISTS stage3_failure_classification text,
  ADD COLUMN IF NOT EXISTS stage3_failure_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN document_processing_batches.stage3_failure_input_hash IS
  'SHA-256 hash (hashAiInput in ai-gateway.ts, same algorithm) of the exact Stage 3 scope-reasoning prompt that most recently failed for this batch. NULL until a Stage 3 call has failed at least once. Compared against the CURRENT prompt''s hash before each Stage 3 attempt (shouldSkipStage3Call) so a genuinely unchanged input inherits its failure history and a genuinely changed one does not.';
COMMENT ON COLUMN document_processing_batches.stage3_failure_classification IS
  'classifyAnthropicError classification of the most recent Stage 3 failure for this batch (e.g. application_timeout). NULL until a failure has occurred.';
COMMENT ON COLUMN document_processing_batches.stage3_failure_count IS
  'Consecutive occurrences of stage3_failure_classification for the SAME stage3_failure_input_hash. Reset to 1 whenever the input hash changes, even if the classification happens to repeat. Compared against maxConsecutiveOccurrences(classification) to decide whether the next Stage 3 attempt should be skipped entirely (no further spend) rather than repeating a call whose outcome is already known for this exact input.';

CREATE OR REPLACE FUNCTION record_stage3_failure(
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
  SELECT stage3_failure_input_hash, stage3_failure_classification, stage3_failure_count
  INTO v_prior_input_hash, v_prior_classification, v_prior_count
  FROM document_processing_batches
  WHERE id = p_batch_id
  FOR UPDATE;

  IF NOT FOUND THEN
    -- Batch row doesn't exist (deleted, or a bad id) — nothing to record.
    -- Matches record_ai_failure's own best-effort posture: a lookup failure
    -- here must never throw and break the caller's own failure handling.
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

  -- Same boundary semantics as record_ai_failure: compares the count BEFORE
  -- this failure (v_prior_count) to the max — so a first-ever failure on a
  -- given input (v_prior_count = 0, or a hash/classification change) is
  -- never immediately stopped, and only a repeat past the allowance is.
  v_stop := (p_max_occurrences <= 0) OR (v_same_input AND v_prior_count >= p_max_occurrences);

  UPDATE document_processing_batches
  SET stage3_failure_input_hash = p_input_hash,
      stage3_failure_classification = p_classification,
      stage3_failure_count = v_next_count
  WHERE id = p_batch_id;

  RETURN QUERY SELECT p_classification, v_next_count, v_stop;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION record_stage3_failure IS
  'Atomically records a Stage 3 (scope reasoning) call failure against document_processing_batches.stage3_failure_input_hash/_classification/_count and decides, in the same transaction via SELECT...FOR UPDATE, whether to stop retrying this exact input — the Stage-3-specific analogue of record_ai_failure (migration 043), keyed by batch + input hash instead of files.id since Stage 3 has no per-file correspondence. p_max_occurrences mirrors maxConsecutiveOccurrences in pipeline-logic.ts; keep all three (this function, that constant, and shouldSkipStage3Call/nextStage3FailureHistory) in sync if any changes.';

NOTIFY pgrst, 'reload schema';
