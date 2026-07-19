-- ============================================================
-- WorkA — Phase 1, increment 1: estimate_runs as the single workflow
-- source of truth (additive projection, not yet a cutover)
-- ============================================================
-- Context: "what is the current state of this document -> estimate
-- pipeline run" today has no single answer. It's reconstructed on demand
-- by reading up to five different tables depending on who's asking:
-- files.intake_status/intake_stage/intake_pct (migration 052's derived
-- projection), document_processing_batches (+ its migration 053 stall_*
-- columns), document_processing_jobs (per-document extraction),
-- job_intake_locks (is smooth-responder currently running), and
-- clarifying_questions (is the run blocked waiting on the builder). The
-- SSE poller, the recovery cron, and JobSnapshotPanel's risk list each
-- independently re-derive a partial answer from some subset of these.
--
-- Per the explicit Phase 1 requirement this migration is scoped to:
-- estimate_runs must become the single workflow source of truth, but
-- WITHOUT creating a second, competing status/recovery system, WITHOUT
-- breaking the existing SSE/UI contract, and WITH a trivial rollback.
-- The only way to satisfy all three at once in one increment is to make
-- estimate_runs a derived, read-only PROJECTION first — reconciled from
-- the existing tables (which remain the actual, authoritative write
-- targets, completely unchanged) — before anything downstream is ever
-- switched to read FROM it instead of computing its own answer. This
-- mirrors the exact pattern jobs.knowledge_confidence (migration 035) and
-- files.intake_status (migration 052) already established in this
-- codebase: "cached view, never authoritative, recomputed and
-- overwritten," not a second source of truth layered on top.
--
-- What this increment deliberately does NOT do (next increments, once
-- this projection has run in production long enough to be trusted):
--   - Nothing reads estimate_runs to make a decision yet. reconcile_
--     estimate_run() is called (in a later, separate patch to the route
--     files) purely as a side effect after the existing recovery cron
--     and SSE routes do their real work against the real tables — so if
--     this migration or its reconciliation function had a bug, the
--     worst case is a wrong or missing PROJECTION row, never a wrong
--     pipeline decision. That's the rollback story: DROP the two tables
--     below (or just stop calling the RPC) and the live pipeline is
--     completely unaffected, because it never depended on them.
--   - The recovery cron's actual reclaim/retry RPCs (migration 037) are
--     UNCHANGED here. "Existing recovery logic migrated into
--     reconciliation of estimate_runs state" starts with reconciliation
--     OBSERVING every recovery action recovery already takes (so
--     estimate_runs stays a truthful mirror of it) — collapsing the
--     recovery cron's own decision logic to read FROM estimate_runs
--     instead of the underlying tables is the next increment, done only
--     once this one has been verified against real production runs.
--   - No UI component is wired to estimate_runs yet.
-- ============================================================

CREATE TABLE IF NOT EXISTS estimate_runs (
  id                        uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  job_id                    uuid        NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  builder_id                uuid        NOT NULL REFERENCES builders(id) ON DELETE CASCADE,
  -- One estimate_runs row per document_processing_batches row (one row per
  -- upload attempt) — same granularity migration 053's own per-batch
  -- checkpoint uses, and for the same reason: a genuinely new upload to a
  -- job that already has a quote must get its own fresh run, not silently
  -- merge into a stale one.
  batch_id                  uuid        UNIQUE REFERENCES document_processing_batches(id) ON DELETE CASCADE,
  status                    text        NOT NULL CHECK (status IN (
                                           'extracting',            -- document-worker queue draining (Stage pre-1/2)
                                           'classifying',            -- Stage 1/2 in progress
                                           'reasoning',              -- Stage 3/4 in progress
                                           'awaiting_clarification', -- blocking clarifying_questions open
                                           'generating_estimate',    -- Stage 5/6 in progress
                                           'complete',               -- quote produced, run terminal
                                           'failed',                 -- terminal, no quote (or ai billing halt / recovery cap hit)
                                           'stalled'                 -- non-terminal but no recent progress; recovery's concern, not the UI's
                                         )),
  quote_id                  uuid        REFERENCES quotes(id),
  documents_total            integer    NOT NULL DEFAULT 0,
  documents_processed        integer    NOT NULL DEFAULT 0,
  documents_failed           integer    NOT NULL DEFAULT 0,
  blocking_questions_open    integer    NOT NULL DEFAULT 0,
  lock_held                  boolean    NOT NULL DEFAULT false,
  stall_reason                text,
  failure_reason               text,
  started_at                 timestamptz NOT NULL DEFAULT now(),
  last_progress_at           timestamptz NOT NULL DEFAULT now(),
  completed_at                timestamptz,
  reconciled_at                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS estimate_runs_job_idx ON estimate_runs (job_id);
CREATE INDEX IF NOT EXISTS estimate_runs_active_idx ON estimate_runs (status)
  WHERE status NOT IN ('complete', 'failed');

COMMENT ON TABLE estimate_runs IS
  'Derived projection of "what state is this upload -> estimate pipeline run in," reconciled from files/document_processing_batches/document_processing_jobs/job_intake_locks/clarifying_questions/quotes by reconcile_estimate_run(). Not yet authoritative for any decision — see migration 056''s header comment for the staged rollout plan. Never write to this table directly outside reconcile_estimate_run().';

CREATE TABLE IF NOT EXISTS estimate_run_events (
  id                bigserial   PRIMARY KEY,
  estimate_run_id   uuid        NOT NULL REFERENCES estimate_runs(id) ON DELETE CASCADE,
  from_status        text,
  to_status          text        NOT NULL,
  detail             jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS estimate_run_events_run_idx ON estimate_run_events (estimate_run_id, created_at);

COMMENT ON TABLE estimate_run_events IS
  'Append-only status-transition audit trail for estimate_runs, written only by reconcile_estimate_run() when a reconciliation changes status. Not a general-purpose event log — the existing proof_events table already covers builder-facing audit trail; this is pipeline-internal.';

ALTER TABLE estimate_runs      ENABLE ROW LEVEL SECURITY;
ALTER TABLE estimate_run_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY "estimate_runs_own_builder" ON estimate_runs
  FOR ALL USING (builder_id = auth.uid());

CREATE POLICY "estimate_run_events_own_builder" ON estimate_run_events
  FOR ALL USING (estimate_run_id IN (SELECT id FROM estimate_runs WHERE builder_id = auth.uid()));

-- ── Reconciliation: the one function that derives estimate_runs state ──
--
-- Pure read of the real, authoritative tables in, one upsert out. Never
-- writes to files/document_processing_batches/document_processing_jobs/
-- job_intake_locks/clarifying_questions/quotes — those keep being written
-- exactly as they are today, by exactly the same code paths as today.
-- Safe to call as often as wanted (idempotent — recomputes and overwrites,
-- same pattern as jobs.knowledge_confidence / files.intake_status), and
-- safe to call from multiple concurrent callers (single-row UPSERT keyed
-- on the batch's own unique id, no read-then-write race window that
-- matters — a lost update here just means the next reconciliation call
-- corrects it, since nothing downstream depends on this table yet).
CREATE OR REPLACE FUNCTION reconcile_estimate_run(p_batch_id uuid)
RETURNS uuid AS $$
DECLARE
  v_batch          document_processing_batches%ROWTYPE;
  v_docs_total     integer;
  v_docs_processed integer;
  v_docs_failed    integer;
  v_blocking_open  integer;
  v_lock_held      boolean;
  v_status         text;
  v_stall_reason   text;
  v_failure_reason text;
  v_run_id         uuid;
  v_prev_status    text;
  v_last_progress  timestamptz;
BEGIN
  SELECT status INTO v_prev_status FROM estimate_runs WHERE batch_id = p_batch_id;
  SELECT * INTO v_batch FROM document_processing_batches WHERE id = p_batch_id;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  SELECT count(*) FILTER (WHERE true),
         count(*) FILTER (WHERE status = 'completed'),
         count(*) FILTER (WHERE status = 'failed')
    INTO v_docs_total, v_docs_processed, v_docs_failed
    FROM document_processing_jobs
    WHERE parent_job_id = p_batch_id;

  SELECT count(*) INTO v_blocking_open
    FROM clarifying_questions
    WHERE job_id = v_batch.job_id AND blocking = true AND status = 'open';

  SELECT EXISTS(SELECT 1 FROM job_intake_locks WHERE job_id = v_batch.job_id)
    INTO v_lock_held;

  -- Status derivation mirrors the same precedence the SSE route and
  -- recovery cron already apply informally today; this just makes it one
  -- explicit, testable CASE instead of scattered conditionals.
  v_stall_reason := v_batch.stall_reason;
  v_failure_reason := NULL;

  IF v_batch.quote_id IS NOT NULL AND EXISTS (
       SELECT 1 FROM quotes WHERE id = v_batch.quote_id AND status <> 'draft'
     ) THEN
    v_status := 'complete';
  ELSIF v_batch.status = 'failed' AND v_docs_processed = 0 THEN
    v_status := 'failed';
    v_failure_reason := 'all documents in this batch failed extraction';
  ELSIF v_blocking_open > 0 THEN
    v_status := 'awaiting_clarification';
  ELSIF v_batch.quote_id IS NOT NULL THEN
    v_status := 'generating_estimate';
  ELSIF v_batch.scope_reasoning_completed_at IS NOT NULL THEN
    v_status := 'generating_estimate';
  ELSIF v_batch.classification_triggered THEN
    v_status := 'reasoning';
  ELSIF v_batch.status IN ('completed', 'completed_with_failures') THEN
    v_status := 'classifying';
  ELSE
    v_status := 'extracting';
  END IF;

  -- A wall-clock stall (migration 053) or a dead lock with no forward
  -- motion overrides the structural status above — "stalled" is a
  -- recovery signal, not a pipeline stage, so it only applies to a run
  -- that isn't already terminal.
  IF v_status NOT IN ('complete', 'failed') AND v_stall_reason IS NOT NULL THEN
    v_status := 'stalled';
  END IF;

  v_last_progress := GREATEST(
    v_batch.updated_at,
    COALESCE((SELECT max(updated_at) FROM document_processing_jobs WHERE parent_job_id = p_batch_id), v_batch.updated_at)
  );

  INSERT INTO estimate_runs AS er (
    job_id, builder_id, batch_id, status, quote_id,
    documents_total, documents_processed, documents_failed,
    blocking_questions_open, lock_held, stall_reason, failure_reason,
    last_progress_at, completed_at, reconciled_at
  ) VALUES (
    v_batch.job_id, v_batch.builder_id, p_batch_id, v_status, v_batch.quote_id,
    COALESCE(v_docs_total, 0), COALESCE(v_docs_processed, 0), COALESCE(v_docs_failed, 0),
    v_blocking_open, v_lock_held, v_stall_reason, v_failure_reason,
    v_last_progress,
    CASE WHEN v_status IN ('complete', 'failed') THEN now() ELSE NULL END,
    now()
  )
  ON CONFLICT (batch_id) DO UPDATE SET
    status = EXCLUDED.status,
    quote_id = EXCLUDED.quote_id,
    documents_total = EXCLUDED.documents_total,
    documents_processed = EXCLUDED.documents_processed,
    documents_failed = EXCLUDED.documents_failed,
    blocking_questions_open = EXCLUDED.blocking_questions_open,
    lock_held = EXCLUDED.lock_held,
    stall_reason = EXCLUDED.stall_reason,
    failure_reason = EXCLUDED.failure_reason,
    last_progress_at = EXCLUDED.last_progress_at,
    completed_at = COALESCE(er.completed_at, EXCLUDED.completed_at),
    reconciled_at = now()
  RETURNING er.id INTO v_run_id;

  IF v_prev_status IS DISTINCT FROM v_status THEN
    INSERT INTO estimate_run_events (estimate_run_id, from_status, to_status, detail)
    VALUES (v_run_id, v_prev_status, v_status, jsonb_build_object(
      'documents_total', v_docs_total, 'documents_processed', v_docs_processed,
      'documents_failed', v_docs_failed, 'blocking_questions_open', v_blocking_open
    ));
  END IF;

  RETURN v_run_id;
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION reconcile_estimate_run(uuid) IS
  'Derives estimate_runs state for one document_processing_batches row from the real, authoritative tables (document_processing_jobs, clarifying_questions, job_intake_locks, quotes) and upserts it. Read-only against everything except estimate_runs/estimate_run_events. Idempotent and safe to call repeatedly or concurrently. Called as a best-effort side effect after real pipeline/recovery work happens, not before or instead of it.';

NOTIFY pgrst, 'reload schema';
