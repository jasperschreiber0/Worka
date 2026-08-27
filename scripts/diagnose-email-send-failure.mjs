#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only baseline for the
// email-draft send persistence-truthfulness fix (Round 6 reliability audit
// finding).
//
// There is no reliable way to cross-reference communication_history/
// proof_events against Resend's own delivery records from a read-only DB
// query alone (Resend has no bulk "list sent emails" endpoint keyed by our
// data). This script instead reports current baseline counts so the E2E run
// (scripts/run-email-send-failure-e2e.mjs) can diff against them and prove
// the fix's two invariants directly:
//   - a genuine Resend-rejected send creates NEITHER a communication_history
//     row NOR a proof_events 'email_sent' row
//   - a genuine successful send still creates both, unchanged from before
//
// Read-only. Modifies nothing.
//
// Usage: node scripts/diagnose-email-send-failure.mjs
// ============================================================

import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error(JSON.stringify({ event: 'config_error', message: 'NEXT_PUBLIC_SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY must be set' }))
  process.exit(1)
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const since = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()

  const { count: proofCount, error: proofErr } = await supabase
    .from('proof_events')
    .select('id', { count: 'exact', head: true })
    .eq('event_type', 'email_sent')
    .gte('created_at', since)

  if (proofErr) {
    console.error(JSON.stringify({ event: 'proof_events_query_failed', error: proofErr.message }))
    process.exit(1)
  }

  const { count: commCount, error: commErr } = await supabase
    .from('communication_history')
    .select('id', { count: 'exact', head: true })
    .eq('direction', 'outbound')
    .eq('channel', 'email')
    .gte('timestamp', since)

  if (commErr) {
    console.error(JSON.stringify({ event: 'communication_history_query_failed', error: commErr.message }))
    process.exit(1)
  }

  console.log(JSON.stringify({
    event: 'run_complete',
    window: 'last_24h',
    proof_events_email_sent_count: proofCount ?? 0,
    communication_history_outbound_email_count: commCount ?? 0,
  }))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
