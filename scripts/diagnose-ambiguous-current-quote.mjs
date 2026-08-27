#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only, platform-wide
// production check for the ambiguous-current-quote-selection concern
// (Round 11 reliability audit).
//
// Investigates whether jobs exist with:
//   - multiple quotes
//   - duplicate `version` values for the same job (the exact tie
//     getContractValueForJob / snapshot / applyApprovedVariationToQuote's
//     untiebroken `order('version', {ascending:false}).limit(1)` can't
//     resolve deterministically)
//   - more than one quote that "looks current" (approved/sent, or is_current)
//   - financial divergence between quotes for the same job
//   - a case where the highest-version quote and the is_current quote
//     actually DIFFER for the same job (proves different consumers really
//     could select different rows, not just theoretically)
//
// Read-only. Modifies nothing.
//
// Usage: node scripts/diagnose-ambiguous-current-quote.mjs
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

  const { data: allQuotes, error: quotesErr } = await supabase
    .from('quotes')
    .select('id, job_id, version, status, is_current, total_cost, created_at')

  if (quotesErr) {
    console.error(JSON.stringify({ event: 'quotes_query_failed', error: quotesErr.message }))
    process.exit(1)
  }

  const rows = allQuotes ?? []
  console.log(JSON.stringify({ event: 'total_quotes', count: rows.length }))

  const byJob = new Map()
  for (const q of rows) {
    const list = byJob.get(q.job_id) ?? []
    list.push(q)
    byJob.set(q.job_id, list)
  }

  const multiQuoteJobs = Array.from(byJob.entries()).filter(([, qs]) => qs.length > 1)
  console.log(JSON.stringify({ event: 'jobs_with_multiple_quotes_count', count: multiQuoteJobs.length }))

  const duplicateVersionJobs = multiQuoteJobs.filter(([, qs]) => {
    const versions = qs.map((q) => q.version)
    return new Set(versions).size !== versions.length
  })
  console.log(JSON.stringify({
    event: 'jobs_with_duplicate_version_count',
    count: duplicateVersionJobs.length,
    rows: duplicateVersionJobs.slice(0, 20).map(([jobId, qs]) => ({
      job_id: jobId,
      quotes: qs.map((q) => ({ id: q.id, version: q.version, status: q.status, is_current: q.is_current, total_cost: q.total_cost, created_at: q.created_at })),
    })),
  }))

  const multipleCurrentLookingJobs = multiQuoteJobs.filter(([, qs]) => {
    const currentLooking = qs.filter((q) => q.status === 'approved' || q.status === 'sent')
    return currentLooking.length > 1
  })
  console.log(JSON.stringify({
    event: 'jobs_with_multiple_current_looking_quotes_count',
    count: multipleCurrentLookingJobs.length,
    rows: multipleCurrentLookingJobs.slice(0, 20).map(([jobId, qs]) => ({
      job_id: jobId,
      quotes: qs.map((q) => ({ id: q.id, version: q.version, status: q.status, is_current: q.is_current })),
    })),
  }))

  // For every job with multiple quotes, compute the row highest-version
  // (no tiebreak, mirroring the app's own ORDER BY) would select vs the
  // row is_current actually marks, and flag any mismatch.
  const mismatches = []
  for (const [jobId, qs] of multiQuoteJobs) {
    const sorted = [...qs].sort((a, b) => (b.version ?? 0) - (a.version ?? 0))
    const topVersion = sorted[0]?.version
    const tiedAtTop = sorted.filter((q) => q.version === topVersion)
    const currentRow = qs.find((q) => q.is_current)
    if (tiedAtTop.length > 1) {
      // Genuine tie -- which one the DB returns first is not something this
      // script can predict (that's exactly the defect), but we can report
      // whether the tied set even includes the is_current row.
      mismatches.push({
        job_id: jobId,
        kind: 'tied_top_version',
        tied_version: topVersion,
        tied_quote_ids: tiedAtTop.map((q) => q.id),
        is_current_quote_id: currentRow?.id ?? null,
        is_current_in_tied_set: currentRow ? tiedAtTop.some((q) => q.id === currentRow.id) : null,
      })
    } else if (currentRow && sorted[0].id !== currentRow.id) {
      mismatches.push({
        job_id: jobId,
        kind: 'highest_version_differs_from_is_current',
        highest_version_quote_id: sorted[0].id,
        highest_version: sorted[0].version,
        is_current_quote_id: currentRow.id,
        is_current_version: currentRow.version,
      })
    }
  }
  console.log(JSON.stringify({
    event: 'quote_selection_mismatch_count',
    description: 'jobs where the highest-version query (getContractValueForJob/snapshot/applyApprovedVariationToQuote) could select a DIFFERENT row than quotes.is_current (the DB-enforced canonical marker) -- direct evidence different consumers can disagree',
    count: mismatches.length,
    rows: mismatches.slice(0, 30),
  }))

  // Financial divergence: for jobs with multiple quotes, compare total_cost
  // across them (a cheap proxy -- real contract value needs line items, but
  // a differing cached total_cost is itself evidence of real divergence).
  const financialDivergence = multiQuoteJobs
    .map(([jobId, qs]) => {
      const totals = qs.map((q) => q.total_cost).filter((t) => t !== null)
      const distinct = new Set(totals.map((t) => Math.round(Number(t) * 100)))
      return { jobId, qs, distinctTotalsCount: distinct.size }
    })
    .filter((r) => r.distinctTotalsCount > 1)
  console.log(JSON.stringify({
    event: 'jobs_with_financially_divergent_quotes_count',
    count: financialDivergence.length,
    rows: financialDivergence.slice(0, 20).map((r) => ({
      job_id: r.jobId,
      quotes: r.qs.map((q) => ({ id: q.id, version: q.version, status: q.status, is_current: q.is_current, total_cost: q.total_cost })),
    })),
  }))

  console.log(JSON.stringify({
    event: 'run_complete',
    total_quotes: rows.length,
    jobs_with_multiple_quotes: multiQuoteJobs.length,
    jobs_with_duplicate_version: duplicateVersionJobs.length,
    jobs_with_multiple_current_looking_quotes: multipleCurrentLookingJobs.length,
    quote_selection_mismatches: mismatches.length,
    jobs_with_financial_divergence: financialDivergence.length,
  }))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
