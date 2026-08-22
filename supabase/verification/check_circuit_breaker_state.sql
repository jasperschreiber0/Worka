-- Read-only: is the global AI circuit breaker (system_status.ai_circuit_breaker)
-- currently tripped? This is checked by GET /api/cron/intake-recovery
-- immediately before steps 4-5 (the only path that resumes a Stage-6-stalled
-- batch) -- if tripped, those steps are skipped entirely, every tick,
-- regardless of AI_RECOVERY_DISABLED's own value.

\echo '=== system_status: ai_circuit_breaker + ai_limits ==='
SELECT key, value, updated_at
FROM system_status
WHERE key IN ('ai_circuit_breaker', 'ai_limits');

\echo '=== Today''s global + this test builder''s spend ==='
SELECT builder_id, day, cost_cents, call_count
FROM ai_spend_daily
WHERE day = (now() AT TIME ZONE 'utc')::date
ORDER BY builder_id NULLS FIRST;

\echo '=== Most recent ai_operations rows (any builder) -- what triggered a trip, if one happened ==='
SELECT id, created_at, completed_at, builder_id, call_site, status, model, cost_cents, error_classification, error_message
FROM ai_operations
ORDER BY created_at DESC
LIMIT 20;

\echo '=== ai_operations rows specifically for the multi-trade test builder today ==='
SELECT id, created_at, completed_at, call_site, status, cost_cents, error_classification, error_message
FROM ai_operations
WHERE builder_id IN ('00000000-0000-0000-0000-0000000000fd', '00000000-0000-0000-0000-0000000000fc')
  AND created_at > now() - interval '2 hours'
ORDER BY created_at DESC
LIMIT 30;
