-- Read-only: total Anthropic cost for the latest job's ai_operations.
\echo '=== Total cost (cents) for latest job ==='
SELECT count(*) AS total_ops, sum(cost_cents) AS total_cost_cents
FROM ai_operations
WHERE scope_key LIKE (
  (SELECT j.id::text FROM jobs j WHERE j.builder_id = '00000000-0000-0000-0000-0000000000fd' ORDER BY j.created_at DESC LIMIT 1)
  || ':%'
);
