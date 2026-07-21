-- ============================================================
-- WorkA — document processing queue runtime health monitoring
-- ============================================================
-- Read-only views/functions over document_processing_jobs/batches for
-- operational monitoring — replaces the manual runbook's "check for stuck
-- jobs" SQL with objects that can be queried directly (a dashboard, a
-- scheduled alert query, or the synthetic health check script) instead of
-- re-typing ad hoc SQL during an incident. None of these mutate data.
--
-- Safe to (re-)run any time; CREATE OR REPLACE VIEW / FUNCTION throughout.
-- ============================================================

-- ─── Stuck jobs ─────────────────────────────────────────────────────────────
-- A 'running' job whose locked_at is older than the same 3-minute staleness
-- window reclaim_stale_document_jobs (migration 036) uses. In steady state
-- this view should normally be empty within a few minutes of a crash —
-- claim_next_document_job's self-heal sweeps it away on the next claim
-- against that batch. Non-empty for a sustained period means either that
-- batch has no more workers chaining into it (check whether its
-- document-worker chain actually died, not just this one job) or the sweep
-- itself is failing.
CREATE OR REPLACE VIEW stuck_document_jobs AS
SELECT
  j.id AS job_id,
  j.parent_job_id,
  j.document_id,
  j.attempts,
  j.locked_at,
  now() - j.locked_at AS stuck_for,
  b.job_id AS worka_job_id,
  b.builder_id
FROM document_processing_jobs j
JOIN document_processing_batches b ON b.id = j.parent_job_id
WHERE j.status = 'running'
  AND j.locked_at IS NOT NULL
  AND j.locked_at < now() - interval '3 minutes'
ORDER BY j.locked_at;

COMMENT ON VIEW stuck_document_jobs IS
  'document_processing_jobs rows stuck at status=''running'' past the 3-minute staleness window reclaim_stale_document_jobs (migration 036) uses. Should self-clear on the next claim against the same batch; persistent rows indicate that batch''s worker chain has stopped entirely.';

-- ─── Failed jobs (recent) ───────────────────────────────────────────────────
CREATE OR REPLACE VIEW failed_document_jobs_recent AS
SELECT
  j.id AS job_id,
  j.parent_job_id,
  j.document_id,
  j.attempts,
  j.error_message,
  j.updated_at AS failed_at,
  b.job_id AS worka_job_id,
  b.builder_id
FROM document_processing_jobs j
JOIN document_processing_batches b ON b.id = j.parent_job_id
WHERE j.status = 'failed'
  AND j.updated_at > now() - interval '24 hours'
ORDER BY j.updated_at DESC;

COMMENT ON VIEW failed_document_jobs_recent IS
  'document_processing_jobs permanently failed (exhausted retry_or_fail_document_job''s 3-attempt cap) in the last 24 hours. Each row is a document a builder''s upload silently dropped from estimate generation unless completed_with_failures'' partial-success path surfaced it in the UI.';

-- ─── Retry rate ─────────────────────────────────────────────────────────────
-- attempts > 1 means the job needed at least one retry (whether it went on
-- to succeed or eventually failed). A rising rate is an early signal of a
-- systemic extraction problem (a bad document type, a Storage outage, a
-- gateTextExtraction budget that's too tight) well before it shows up as
-- outright failures.
CREATE OR REPLACE FUNCTION document_job_retry_rate(p_window interval DEFAULT interval '24 hours')
RETURNS TABLE(
  window_start timestamptz,
  total_jobs bigint,
  retried_jobs bigint,
  retry_rate_pct numeric
) AS $$
  SELECT
    now() - p_window,
    count(*),
    count(*) FILTER (WHERE attempts > 1),
    CASE WHEN count(*) = 0 THEN 0
         ELSE round(100.0 * count(*) FILTER (WHERE attempts > 1) / count(*), 2)
    END
  FROM document_processing_jobs
  WHERE status IN ('completed', 'failed')
    AND updated_at > now() - p_window;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION document_job_retry_rate IS
  'Share of terminal (completed or failed) document_processing_jobs in the trailing window that needed at least one retry. A rising trend is an early signal of a systemic extraction problem, not just isolated bad documents.';

-- ─── Processing latency ─────────────────────────────────────────────────────
-- started_at/completed_at bound the claim-to-finish wall time for one
-- document (extraction + the two RPC round trips), not the whole batch —
-- use document_batch_completion_latency below for the end-to-end batch
-- figure the builder actually experiences.
CREATE OR REPLACE FUNCTION document_processing_latency_stats(p_window interval DEFAULT interval '24 hours')
RETURNS TABLE(
  window_start timestamptz,
  sample_count bigint,
  avg_ms numeric,
  p50_ms numeric,
  p95_ms numeric,
  max_ms numeric
) AS $$
  SELECT
    now() - p_window,
    count(*),
    round(avg(extract(epoch FROM (completed_at - started_at)) * 1000)::numeric, 1),
    round((percentile_cont(0.5) WITHIN GROUP (ORDER BY extract(epoch FROM (completed_at - started_at)) * 1000))::numeric, 1),
    round((percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (completed_at - started_at)) * 1000))::numeric, 1),
    round((max(extract(epoch FROM (completed_at - started_at)) * 1000))::numeric, 1)
  FROM document_processing_jobs
  WHERE status = 'completed'
    AND started_at IS NOT NULL AND completed_at IS NOT NULL
    AND completed_at > now() - p_window;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION document_processing_latency_stats IS
  'Per-document claim-to-completion latency (extraction + RPC round trips) for completed jobs in the trailing window. p95_ms rising toward the ~2000ms per-request CPU budget is the leading indicator for the same CPU-exhaustion failure mode migration 034 exists to isolate — worth alerting on well before it starts producing stuck/failed jobs.';

-- ─── Batch completion failures ──────────────────────────────────────────────
CREATE OR REPLACE FUNCTION document_batch_failure_summary(p_window interval DEFAULT interval '7 days')
RETURNS TABLE(
  window_start timestamptz,
  total_batches bigint,
  completed_batches bigint,
  completed_with_failures_batches bigint,
  failed_batches bigint,
  failure_rate_pct numeric
) AS $$
  SELECT
    now() - p_window,
    count(*),
    count(*) FILTER (WHERE status = 'completed'),
    count(*) FILTER (WHERE status = 'completed_with_failures'),
    count(*) FILTER (WHERE status = 'failed'),
    CASE WHEN count(*) = 0 THEN 0
         ELSE round(100.0 * count(*) FILTER (WHERE status IN ('completed_with_failures', 'failed')) / count(*), 2)
    END
  FROM document_processing_batches
  WHERE updated_at > now() - p_window
    AND status IN ('completed', 'completed_with_failures', 'failed');
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION document_batch_failure_summary IS
  'Share of terminal document_processing_batches (an upload as a whole, not one document) that had at least one permanently-failed document in the trailing window. completed_with_failures means the builder still got a partial result; failed means the whole batch produced nothing.';

-- ─── Batch end-to-end latency (what a builder actually experiences) ───────
CREATE OR REPLACE FUNCTION document_batch_completion_latency(p_window interval DEFAULT interval '24 hours')
RETURNS TABLE(
  window_start timestamptz,
  sample_count bigint,
  avg_ms numeric,
  p95_ms numeric,
  max_ms numeric
) AS $$
  SELECT
    now() - p_window,
    count(*),
    round(avg(extract(epoch FROM (b.updated_at - b.created_at)) * 1000)::numeric, 1),
    round((percentile_cont(0.95) WITHIN GROUP (ORDER BY extract(epoch FROM (b.updated_at - b.created_at)) * 1000))::numeric, 1),
    round((max(extract(epoch FROM (b.updated_at - b.created_at)) * 1000))::numeric, 1)
  FROM document_processing_batches b
  WHERE b.status IN ('completed', 'completed_with_failures', 'failed')
    AND b.updated_at > now() - p_window;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION document_batch_completion_latency IS
  'Wall-clock time from batch creation to terminal status, across every document in the batch and however many worker-chain hops that took. This is the number closest to what IntakeProgress.tsx''s builder-facing progress bar actually experienced end to end.';

-- ─── Stuck job_intake_locks (migration 037) ────────────────────────────────
-- The job-lock analogue of stuck_document_jobs: a lock whose last_progress_at
-- is old enough that GET /api/cron/intake-recovery's find_stale_job_intake_
-- locks() (migration 037) would treat it as a candidate for reclaim. In
-- steady state this should self-clear within one recovery-cron cycle
-- (5 min, see vercel.json); a persistently non-empty result means the
-- recovery cron itself isn't running (check CRON_SECRET / Vercel plan —
-- see CLAUDE.md "Independent Intake Recovery Service") rather than the
-- underlying smooth-responder failure recurring indefinitely.
CREATE OR REPLACE VIEW stuck_job_intake_locks AS
SELECT
  l.job_id,
  l.file_id,
  l.started_at,
  l.last_progress_at,
  now() - l.last_progress_at AS stale_for
FROM job_intake_locks l
WHERE (now() - l.last_progress_at > interval '6 minutes')
   OR (now() - l.started_at > interval '16 minutes')
ORDER BY l.last_progress_at;

COMMENT ON VIEW stuck_job_intake_locks IS
  'job_intake_locks rows past the staleness window find_stale_job_intake_locks() (migration 037) uses. Should self-clear within one GET /api/cron/intake-recovery cycle; persistent rows mean the recovery cron itself is not running.';

-- ─── Recent recovery cron activity (migration 037) ─────────────────────────
CREATE OR REPLACE FUNCTION intake_recovery_activity_summary(p_window interval DEFAULT interval '24 hours')
RETURNS TABLE(
  window_start timestamptz,
  run_count bigint,
  runs_with_errors bigint,
  total_document_jobs_reclaimed bigint,
  total_batches_resumed bigint,
  total_job_locks_reclaimed bigint,
  total_stuck_files_retried bigint,
  last_run_at timestamptz
) AS $$
  SELECT
    now() - p_window,
    count(*),
    count(*) FILTER (WHERE jsonb_array_length(errors) > 0),
    coalesce(sum(document_jobs_reclaimed), 0),
    coalesce(sum(batches_resumed), 0),
    coalesce(sum(job_locks_reclaimed), 0),
    coalesce(sum(stuck_files_retried), 0),
    max(run_started_at)
  FROM intake_recovery_runs
  WHERE run_started_at > now() - p_window;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION intake_recovery_activity_summary IS
  'Rollup of GET /api/cron/intake-recovery activity over the trailing window. last_run_at going stale (older than a few multiples of the 5-minute schedule) means the cron itself has stopped firing — check Vercel cron config / CRON_SECRET first, before assuming the pipeline has no stuck jobs to find.';

-- ─── Single-query rollup for a dashboard/alert cron ────────────────────────
CREATE OR REPLACE FUNCTION document_processing_health_summary()
RETURNS TABLE(
  stuck_jobs_count bigint,
  stuck_job_locks_count bigint,
  failed_jobs_last_24h bigint,
  retry_rate_pct_24h numeric,
  latency_p95_ms_24h numeric,
  batch_failure_rate_pct_7d numeric,
  recovery_runs_last_24h bigint,
  recovery_last_run_at timestamptz
) AS $$
  SELECT
    (SELECT count(*) FROM stuck_document_jobs),
    (SELECT count(*) FROM stuck_job_intake_locks),
    (SELECT count(*) FROM failed_document_jobs_recent),
    (SELECT retry_rate_pct FROM document_job_retry_rate(interval '24 hours')),
    (SELECT p95_ms FROM document_processing_latency_stats(interval '24 hours')),
    (SELECT failure_rate_pct FROM document_batch_failure_summary(interval '7 days')),
    (SELECT run_count FROM intake_recovery_activity_summary(interval '24 hours')),
    (SELECT last_run_at FROM intake_recovery_activity_summary(interval '24 hours'));
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION document_processing_health_summary IS
  'One-row rollup of every health signal above, for a single-query dashboard tile or alert-cron check rather than several separate queries. recovery_last_run_at is the fastest way to tell "pipeline is healthy" apart from "recovery cron stopped firing so nothing is being checked."';

-- ─── Deterministic duplicate detection (Phase 1, migration 062) ───────────
-- Aggregate counterpart to the per-event duplicate_document_detected log
-- emitted in document-worker/index.ts at detection time — that log is the
-- audit trail for any ONE duplicate; this is the queryable rollup for
-- "how much is this actually doing," the same total-uploads/duplicates-
-- detected/extraction-jobs-avoided breakdown called for when Phase 1 was
-- specced. Also the concrete artifact Phase 2 ("measure real production
-- data" before building fuzzier, non-byte-identical cross-session
-- matching) is meant to read from — this view is what turns that from an
-- aspiration into something with an actual query behind it.
--
-- Deliberately reports bytes, not a dollar estimate: this repo already has
-- a real per-call cost figure (ai-gateway.ts's estimateCostCents, driven
-- by actual token counts from Anthropic's response), and stacking a
-- bytes-to-tokens-to-dollars guess on top of that here would be a fabricated
-- number dressed as a measured one — the same failure mode this whole
-- pipeline's fact-extraction rules exist to avoid ("never invent a
-- quantity without evidence"). bytes_saved is the honest, defensible proxy;
-- a real cost figure needs the avoided call's actual token estimate, not
-- available from a call that was never made.
-- Extended by migration 063's production validation pass: documents_with_
-- hash/without_hash, hash/lookup failure counts, fallback events, and
-- stage12_calls_avoided/estimated_input_tokens_avoided (all derived from
-- existing columns/jsonb already written by document-worker/smooth-
-- responder — no new architecture, per that pass's own constraint).
CREATE OR REPLACE FUNCTION document_duplicate_detection_summary(p_window interval DEFAULT interval '7 days')
RETURNS TABLE(
  window_start timestamptz,
  total_files_uploaded bigint,
  documents_with_hash bigint,
  documents_without_hash bigint,
  duplicate_files_detected bigint,
  extraction_jobs_avoided bigint,
  duplicate_rate_pct numeric,
  last_duplicate_detected_at timestamptz,
  -- ── Processing: Claude calls avoided ──────────────────────────────────
  -- Stage 1 and Stage 2 are literally the same Claude call in this
  -- pipeline (one call classifies documents AND builds the fact base —
  -- see smooth-responder's own header comment), so there is no separate
  -- "Stage 2 calls avoided" figure to report; this single column covers
  -- both, unlike extraction_jobs_avoided/duplicate_files_detected (which
  -- ARE 1:1 with each document), a Stage 1/2 Claude call is only fully
  -- avoided when EVERY document in a batch turns out to be a duplicate
  -- (smooth-responder/index.ts's all_documents_duplicate_reused_existing_
  -- quote path) — a batch with a MIX of new and duplicate files still
  -- makes the call, just with a smaller payload. Derived from
  -- document_processing_jobs.result->>'duplicate' (already written by
  -- document-worker), no new column needed for this one.
  stage12_calls_avoided bigint,
  -- Rough order-of-magnitude estimate only, using this codebase's own
  -- existing approximation conventions (base64 inflates raw bytes by
  -- ~4/3; callTool's own diagnostic logging already estimates tokens as
  -- chars/4) rather than a fabricated precise figure — see this function's
  -- own COMMENT for why a real dollar estimate is deliberately not
  -- reported. Null whenever no duplicate in the window has a recorded
  -- file_size_bytes (files uploaded before migration 063, or a hash
  -- failure on that file).
  estimated_input_tokens_avoided bigint,
  -- ── Failures (all fail-safe — none of these ever blocked an upload) ───
  hash_generation_failures bigint,
  duplicate_lookup_failures bigint,
  fallback_to_normal_processing_events bigint
) AS $$
  SELECT
    now() - p_window,
    count(*),
    count(*) FILTER (WHERE content_hash IS NOT NULL),
    count(*) FILTER (WHERE content_hash IS NULL),
    count(*) FILTER (WHERE duplicate_of_file_id IS NOT NULL),
    -- Equal to duplicate_files_detected by construction, not a coincidence:
    -- document-worker returns its 'duplicate' outcome (skipping all
    -- extraction) exactly when it sets duplicate_of_file_id, one-to-one —
    -- kept as its own named column since Phase 1's spec asked for this
    -- metric by that name specifically, not merely inferable from the one
    -- above.
    count(*) FILTER (WHERE duplicate_of_file_id IS NOT NULL),
    CASE WHEN count(*) = 0 THEN 0
         ELSE round(100.0 * count(*) FILTER (WHERE duplicate_of_file_id IS NOT NULL) / count(*), 2)
    END,
    max(created_at) FILTER (WHERE duplicate_of_file_id IS NOT NULL),
    (
      SELECT count(*)
      FROM document_processing_batches b
      WHERE b.created_at > now() - p_window
        AND EXISTS (SELECT 1 FROM document_processing_jobs j WHERE j.parent_job_id = b.id AND j.status = 'completed')
        AND NOT EXISTS (
          SELECT 1 FROM document_processing_jobs j
          WHERE j.parent_job_id = b.id AND j.status = 'completed'
            AND COALESCE((j.result->>'duplicate')::boolean, false) = false
        )
    ),
    round(sum(file_size_bytes) FILTER (WHERE duplicate_of_file_id IS NOT NULL) / 3.0)::bigint,
    count(*) FILTER (WHERE content_hash_failed),
    count(*) FILTER (WHERE duplicate_lookup_failed),
    count(*) FILTER (WHERE content_hash_failed OR duplicate_lookup_failed)
  FROM files
  WHERE created_at > now() - p_window;
$$ LANGUAGE sql STABLE;

COMMENT ON FUNCTION document_duplicate_detection_summary IS
  'Rollup of deterministic duplicate-detection activity (files.content_hash/duplicate_of_file_id, migration 062; file_size_bytes/content_hash_failed/duplicate_lookup_failed, migration 063) over the trailing window. This is the production-data source Phase 2 (reliable non-byte-identical cross-session matching) is meant to be built against, not built blind ahead of it. estimated_input_tokens_avoided is a deliberately rough, labelled order-of-magnitude estimate (bytes / 3, combining this codebase''s own existing base64-inflation and chars-per-token approximations) — NOT a dollar figure: a real cost estimate needs an avoided call''s actual token count, which does not exist for a call that was never made, and fabricating one would be the same "invented quantity without evidence" failure mode this pipeline''s own fact-extraction rules exist to avoid.';
