#!/usr/bin/env node
// ============================================================
// One-time, evidence-based production config change (not a recurring
// diagnostic -- run once, kept here for audit trail).
//
// Raises system_status.ai_limits from the migration-054 defaults
// (builder_daily_cents=1000 / global_daily_cents=2500, i.e. $10 / $25 per
// day) to values sized from REAL observed spend on a traced real customer
// job (see the post-launch validation session this script was written in):
//   - A real, successful 15-document pipeline run cost $0.6622-$2.3829
//     total (ai_operations.cost_cents, summed per day, for the traced
//     builder across 10 days of real history).
//   - That builder's own daily spend never approached the $10/day cap in
//     any of those 10 days -- the per-file "budget_refused" failures on
//     the traced job are far better explained by the shared GLOBAL $25/day
//     cap being exhausted (real usage + this session's own extensive
//     E2E/testing traffic share the same pool) than by the per-builder cap.
//   - New builder_daily_cents = 3000 ($30/day): ~12-45x a single real run,
//     room for several full retries in one account without materially
//     raising single-account blast radius.
//   - New global_daily_cents = 15000 ($150/day): migration 054's own
//     stated target was "60-80 full pipelines/day of headroom" against an
//     assumed $0.31-0.42/pipeline cost; using the REAL observed
//     $0.67-2.38/pipeline cost against that same target lands in this
//     range.
//
// Does NOT touch ai_circuit_breaker, does not weaken the fail-closed
// design, does not change any pipeline/gateway code -- only the two
// numbers in one jsonb row, exactly the "tunable via SQL without a
// deploy" mechanism migration 054 built for this.
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY must be set' }))
  process.exit(1)
}

const NEW_BUILDER_DAILY_CENTS = 3000
const NEW_GLOBAL_DAILY_CENTS = 15000

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

async function main() {
  const { data: before, error: readErr } = await supabase
    .from('system_status')
    .select('key, value, updated_at')
    .eq('key', 'ai_limits')
    .single()
  if (readErr || !before) {
    log('read_before_failed', { error: readErr?.message })
    process.exit(1)
  }
  log('ai_limits_before', before)

  const newValue = { global_daily_cents: NEW_GLOBAL_DAILY_CENTS, builder_daily_cents: NEW_BUILDER_DAILY_CENTS }
  const { error: updateErr } = await supabase
    .from('system_status')
    .update({ value: newValue, updated_at: new Date().toISOString() })
    .eq('key', 'ai_limits')
  if (updateErr) {
    log('update_failed', { error: updateErr.message })
    process.exit(1)
  }

  const { data: after, error: readAfterErr } = await supabase
    .from('system_status')
    .select('key, value, updated_at')
    .eq('key', 'ai_limits')
    .single()
  if (readAfterErr || !after) {
    log('read_after_failed', { error: readAfterErr?.message })
    process.exit(1)
  }
  log('ai_limits_after', after)

  const applied = after.value?.global_daily_cents === NEW_GLOBAL_DAILY_CENTS && after.value?.builder_daily_cents === NEW_BUILDER_DAILY_CENTS
  log(applied ? 'change_confirmed' : 'change_FAILED_verification', { expected: newValue, actual: after.value })
  process.exit(applied ? 0 : 1)
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
