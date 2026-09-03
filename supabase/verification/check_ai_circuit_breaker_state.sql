-- READ-ONLY. GET /api/cron/intake-recovery's step 5 (stuck-batch retry) is
-- entirely inside a branch gated by `AI_RECOVERY_DISABLED || aiCircuitBreakerTripped`
-- (route.ts line 652) -- if the breaker is tripped, the whole block is
-- skipped every tick, logged only as recovery_ai_steps_skipped (not
-- surfaced as an error). This checks the exact row the route reads
-- (system_status, key 'ai_circuit_breaker') plus ai_spend_daily to see
-- whether a real daily-limit trip is the actual blocker. Zero writes.

\echo '=== system_status ai_circuit_breaker row ==='
SELECT key, value, updated_at FROM system_status WHERE key = 'ai_circuit_breaker';

\echo '=== system_status ai_limits row (for context) ==='
SELECT key, value, updated_at FROM system_status WHERE key = 'ai_limits';

\echo '=== ai_spend_daily, most recent rows ==='
SELECT * FROM ai_spend_daily ORDER BY day DESC LIMIT 5;

\echo '=== now ==='
SELECT now();
