#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only production check
// for the Stage 3 checkpoint truthfulness fix (finding #1 of the reliability
// audit): compares document_processing_batches.stage3_completed_trade_ids
// against the trade_category_ids actually present in scope_items for the
// same job, and asserts every checkpointed trade has a real persisted row.
//
// Usage: JOB_ID=<uuid> [BATCH_ID=<uuid>] node scripts/diagnose-stage3-checkpoint-consistency.mjs
// Read-only. Deletes nothing.
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
const JOB_ID = process.env.JOB_ID
const BATCH_ID = process.env.BATCH_ID

if (!SUPABASE_URL || !SERVICE_ROLE_KEY || !JOB_ID) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, JOB_ID must be set' }))
  process.exit(1)
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: scopeRows, error: scopeErr } = await supabase
    .from('scope_items')
    .select('trade_category_id')
    .eq('job_id', JOB_ID)
  if (scopeErr) {
    console.error(JSON.stringify({ event: 'scope_items_read_failed', error: scopeErr.message }))
    process.exit(1)
  }
  const persistedTradeIds = new Set((scopeRows ?? []).map((r) => r.trade_category_id))

  let checkpointTradeIds = []
  if (BATCH_ID) {
    const { data: batchRow, error: batchErr } = await supabase
      .from('document_processing_batches')
      .select('stage3_completed_trade_ids, scope_reasoning_completed_at')
      .eq('id', BATCH_ID)
      .single()
    if (batchErr) {
      console.error(JSON.stringify({ event: 'batch_read_failed', error: batchErr.message }))
      process.exit(1)
    }
    checkpointTradeIds = batchRow?.stage3_completed_trade_ids ?? []
    console.log(JSON.stringify({ event: 'batch_state', scope_reasoning_completed_at: batchRow?.scope_reasoning_completed_at, stage3_completed_trade_ids: checkpointTradeIds }))
  } else {
    // No batch row (legacy no-batch path) — nothing to compare the
    // checkpoint against; just report persisted scope_items.
    console.log(JSON.stringify({ event: 'no_batch_id_supplied', note: 'reporting persisted scope_items only' }))
  }

  console.log(JSON.stringify({ event: 'persisted_scope_items_trade_ids', trade_ids: Array.from(persistedTradeIds).sort((a, b) => a - b) }))

  const orphanedCheckpointTradeIds = checkpointTradeIds.filter((id) => !persistedTradeIds.has(id))

  const ok = orphanedCheckpointTradeIds.length === 0
  console.log(JSON.stringify({
    event: ok ? 'check_passed' : 'check_FAILED',
    name: 'every_checkpointed_trade_has_persisted_scope_data',
    checkpoint_trade_ids: checkpointTradeIds,
    persisted_trade_ids: Array.from(persistedTradeIds).sort((a, b) => a - b),
    orphaned_checkpoint_trade_ids: orphanedCheckpointTradeIds,
  }))

  process.exit(ok ? 0 : 1)
}

main()
