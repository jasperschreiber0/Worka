#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only, platform-wide
// production check for the quote-revise persistence-truthfulness fix
// (Round 8 reliability audit finding).
//
// Looks for the exact gap this fix closes: a job whose is_current quote is
// a 'draft' while an older, higher-status ('sent'/'approved') quote exists
// for the same job -- the shape a pre-fix revise of an already-sent/
// approved quote left behind. getContractValueForJob/the job snapshot both
// resolve "the job's quote" as highest-version with no status filter, so
// this shape means the job's displayed contract value is a draft nobody
// has agreed to.
//
// Read-only. Modifies nothing.
//
// Usage: node scripts/diagnose-quote-revise-truthfulness.mjs
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

  const { data: currentDrafts, error: currentErr } = await supabase
    .from('quotes')
    .select('id, job_id, builder_id, status, version, is_current')
    .eq('is_current', true)
    .eq('status', 'draft')

  if (currentErr) {
    console.error(JSON.stringify({ event: 'current_drafts_query_failed', error: currentErr.message }))
    process.exit(1)
  }

  const rows = currentDrafts ?? []
  console.log(JSON.stringify({ event: 'current_draft_quotes_count', count: rows.length }))

  if (rows.length === 0) {
    console.log(JSON.stringify({ event: 'run_complete', poisoned_count: 0 }))
    return
  }

  const jobIds = rows.map((r) => r.job_id)
  const higherStatusByJob = new Map()
  const CHUNK = 200
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const chunk = jobIds.slice(i, i + CHUNK)
    const { data: siblingQuotes, error: siblingErr } = await supabase
      .from('quotes')
      .select('job_id, status, version, is_current')
      .in('job_id', chunk)
      .in('status', ['sent', 'approved'])
    if (siblingErr) {
      console.error(JSON.stringify({ event: 'sibling_quotes_query_failed', error: siblingErr.message }))
      process.exit(1)
    }
    for (const q of siblingQuotes ?? []) {
      const existing = higherStatusByJob.get(q.job_id) ?? []
      existing.push({ status: q.status, version: q.version })
      higherStatusByJob.set(q.job_id, existing)
    }
  }

  const poisoned = rows
    .filter((r) => higherStatusByJob.has(r.job_id))
    .map((r) => ({
      job_id: r.job_id,
      builder_id: r.builder_id,
      current_draft_quote_id: r.id,
      current_draft_version: r.version,
      sent_or_approved_siblings: higherStatusByJob.get(r.job_id),
    }))

  console.log(JSON.stringify({
    event: 'poisoned_revise_state',
    description: "is_current='draft' quote whose job also has a sent/approved quote -- the contract-value-truthfulness gap this fix closes",
    count: poisoned.length,
    rows: poisoned.slice(0, 50),
    truncated: poisoned.length > 50,
  }))

  console.log(JSON.stringify({ event: 'run_complete', poisoned_count: poisoned.length }))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
