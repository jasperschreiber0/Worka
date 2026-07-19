-- ─── 054: AI gateway — spend protection, idempotency, and usage ledger ────────
--
-- Phase 0 of the production-safety plan (see WORKA_IMPLEMENTATION_READINESS.md
-- §2): before any pipeline redesign, every Anthropic call in the app is routed
-- through one shared gateway (supabase/functions/smooth-responder/ai-gateway.ts)
-- backed by these three tables. This closes the two failure classes behind the
-- documented spend incidents:
--   1. Unbounded repeat spend — no per-builder/global daily ceiling existed
--      anywhere, so any retry-loop bug (wall-clock deadlock retriggers,
--      recovery-cron storms) could burn credits until a human noticed.
--   2. Invisible duplicate work — a crash after a successful Claude call but
--      before its result was written left no durable evidence the call ever
--      happened, so the retry repeated the full paid call.
--
-- Additive only: no existing table, column, or RPC is modified or dropped.
-- Rollback is DROP TABLE / DROP FUNCTION with zero risk to existing data.

-- ─── ai_operations: one row per Claude call attempt ──────────────────────────
-- Doubles as (a) the idempotency store — a caller that passes a scope_key
-- checks for a prior 'succeeded' row with the same key + input_hash and reuses
-- its stored result instead of re-calling, and (b) the per-call usage ledger —
-- model, tokens, estimated cost, duration, per call, queryable with SQL.
-- status='running' rows with no terminal update are crash evidence: the call
-- may have reached Anthropic (and been billed) even though no result landed.
CREATE TABLE ai_operations (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    timestamptz NOT NULL DEFAULT now(),
  completed_at  timestamptz,
  builder_id    uuid,
  call_site     text NOT NULL,           -- e.g. 'stage_document_intelligence', 'chat_extract_actions'
  -- Idempotency scope: null for calls where reuse is not wanted (chat, email
  -- drafts — same input twice is a legitimate new request). Non-null for
  -- pipeline stages: '<job_id>:<stage>'. Reuse requires BOTH scope_key and
  -- input_hash to match, so a changed fact base never reuses a stale result.
  scope_key     text,
  input_hash    text,                    -- SHA-256 of the prompt content
  model         text NOT NULL,
  attempt       integer NOT NULL DEFAULT 1,
  status        text NOT NULL DEFAULT 'running'
                  CHECK (status IN ('running', 'succeeded', 'failed')),
  input_tokens  integer,
  output_tokens integer,
  cost_cents    numeric,                 -- estimated from the pricing table in ai-gateway.ts
  duration_ms   integer,
  request_id    text,                    -- Anthropic request id when available
  error_classification text,
  error_message text,
  -- The parsed tool-use result, stored for idempotent reuse. Only populated
  -- when scope_key is set (callers that opted into reuse); null otherwise so
  -- chat/email content isn't retained here redundantly.
  result        jsonb
);

CREATE INDEX ai_operations_scope_idx
  ON ai_operations (scope_key, input_hash)
  WHERE scope_key IS NOT NULL AND status = 'succeeded';
CREATE INDEX ai_operations_builder_day_idx ON ai_operations (builder_id, created_at);
CREATE INDEX ai_operations_created_idx ON ai_operations (created_at);

COMMENT ON TABLE ai_operations IS
  'One row per Anthropic call attempt made through the shared AI gateway. Serves as the idempotency store (scope_key+input_hash → reusable result) and the per-call usage/cost ledger. A row stuck at status=running is crash evidence — the call may have been billed without its result ever landing.';

-- ─── ai_spend_daily: atomic per-day spend counters ───────────────────────────
-- builder_id NULL = the global (all-builders) row for that day. Both rows are
-- updated atomically by record_ai_spend below; the gateway checks them BEFORE
-- every call and refuses (fails closed, with a clear reason) once a limit is
-- reached. A dedicated counter table (not SUM(ai_operations)) so the pre-call
-- check is one indexed row read, not an aggregate scan.
CREATE TABLE ai_spend_daily (
  builder_id  uuid,
  day         date NOT NULL,
  cost_cents  numeric NOT NULL DEFAULT 0,
  call_count  integer NOT NULL DEFAULT 0
);
-- NULLS NOT DISTINCT so the single global row (builder_id NULL) per day is
-- enforced by the same constraint — the exact pattern migration 020 already
-- established for network_rate_aggregates' nullable-state uniqueness.
CREATE UNIQUE INDEX ai_spend_daily_key ON ai_spend_daily (builder_id, day) NULLS NOT DISTINCT;

COMMENT ON TABLE ai_spend_daily IS
  'Per-builder and global (builder_id NULL) daily AI spend counters, maintained atomically by record_ai_spend(). Checked by the AI gateway before every Anthropic call — the enforcement point for the per-builder and global daily spend limits.';

-- ─── system_status: operational flags and tunable limits ─────────────────────
-- One row per key. Seeded with the circuit breaker (manually trippable, and
-- auto-tripped by the gateway when the global daily limit is reached) and the
-- spend limits (tunable by an operator via SQL without a deploy).
CREATE TABLE system_status (
  key         text PRIMARY KEY,
  value       jsonb NOT NULL,
  updated_at  timestamptz NOT NULL DEFAULT now()
);

INSERT INTO system_status (key, value) VALUES
  -- tripped=true stops EVERY gateway-routed Anthropic call app-wide with a
  -- clear error. reason records why (manual trip vs auto limit trip).
  ('ai_circuit_breaker', '{"tripped": false, "reason": null}'),
  -- Cents per UTC day. Deliberately conservative starting values — an
  -- operator raises them from real usage data, not the reverse. At
  -- claude-sonnet-4-6 pricing ($3/$15 per MTok) the global cap of $25/day
  -- covers roughly 60-80 full estimate pipelines/day — far above current
  -- volume, far below incident-scale burn.
  ('ai_limits', '{"global_daily_cents": 2500, "builder_daily_cents": 1000}')
ON CONFLICT (key) DO NOTHING;

COMMENT ON TABLE system_status IS
  'Operational flags and tunable limits, one jsonb value per key. ai_circuit_breaker: global AI kill switch (manual or auto-tripped at the global daily limit). ai_limits: per-builder and global daily AI spend ceilings in cents, tunable via SQL without a deploy.';

-- ─── record_ai_spend: atomic post-call spend accounting ──────────────────────
-- Upserts BOTH the builder's daily row and the global daily row in one
-- transaction and returns the new totals plus the configured limits, so the
-- caller can decide (and log) whether the global breaker should now trip.
-- Same atomic-RPC pattern as record_ai_failure (043) and
-- record_intake_recovery_attempt (051) — a JS-side read-modify-write here
-- would lose increments under the exact concurrent-invocation conditions
-- this system has already hit twice.
CREATE OR REPLACE FUNCTION record_ai_spend(
  p_builder_id uuid,
  p_cost_cents numeric
) RETURNS TABLE (
  builder_day_cents numeric,
  global_day_cents  numeric,
  builder_limit_cents numeric,
  global_limit_cents  numeric
) AS $$
DECLARE
  v_day date := (now() AT TIME ZONE 'utc')::date;
  v_limits jsonb;
  v_builder_total numeric := 0;
  v_global_total numeric := 0;
BEGIN
  SELECT value INTO v_limits FROM system_status WHERE key = 'ai_limits';

  IF p_builder_id IS NOT NULL THEN
    INSERT INTO ai_spend_daily (builder_id, day, cost_cents, call_count)
    VALUES (p_builder_id, v_day, p_cost_cents, 1)
    ON CONFLICT (builder_id, day)
    DO UPDATE SET cost_cents = ai_spend_daily.cost_cents + EXCLUDED.cost_cents,
                  call_count = ai_spend_daily.call_count + 1
    RETURNING cost_cents INTO v_builder_total;
  END IF;

  INSERT INTO ai_spend_daily (builder_id, day, cost_cents, call_count)
  VALUES (NULL, v_day, p_cost_cents, 1)
  ON CONFLICT (builder_id, day)
  DO UPDATE SET cost_cents = ai_spend_daily.cost_cents + EXCLUDED.cost_cents,
                call_count = ai_spend_daily.call_count + 1
  RETURNING cost_cents INTO v_global_total;

  -- Auto-trip the breaker inside the same transaction the limit was crossed
  -- in — not left to the JS caller, whose process may die before acting.
  IF v_global_total >= COALESCE((v_limits->>'global_daily_cents')::numeric, 2500) THEN
    UPDATE system_status
    SET value = jsonb_build_object(
          'tripped', true,
          'reason', 'auto: global daily AI spend limit reached (' || v_global_total || ' cents)'),
        updated_at = now()
    WHERE key = 'ai_circuit_breaker'
      AND (value->>'tripped')::boolean IS DISTINCT FROM true;
  END IF;

  RETURN QUERY SELECT
    v_builder_total,
    v_global_total,
    COALESCE((v_limits->>'builder_daily_cents')::numeric, 1000),
    COALESCE((v_limits->>'global_daily_cents')::numeric, 2500);
END;
$$ LANGUAGE plpgsql;

COMMENT ON FUNCTION record_ai_spend IS
  'Atomically adds one call''s estimated cost to the builder''s and the global daily spend rows, auto-trips the ai_circuit_breaker in the same transaction when the global daily limit is crossed, and returns the new totals plus configured limits. Called by the AI gateway after every Anthropic call.';

-- Force PostgREST to pick the new objects up immediately (the 027/051 lesson:
-- db push alone does not reliably reload the schema cache, and a stale cache
-- here would silently disable the exact accounting this migration exists for).
NOTIFY pgrst, 'reload schema';
