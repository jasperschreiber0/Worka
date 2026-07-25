#!/usr/bin/env node
// ============================================================
// WorkA — dev-mode: margin reconciliation audit (dry run, zero writes)
// ============================================================
// PURPOSE: quantify which existing quotes/invoice schedules were affected by
// the client_price calculation bug (blanket quote.margin_pct instead of each
// line item's own margin_pct) — before and separate from any decision to
// backfill anything. Makes NO database writes.
//
// Two distinct things this reports, deliberately kept apart:
//
// 1. Quotes: recomputes client_price both ways (old blanket formula vs. the
//    new canonical calculateClientPrice) for every quote and reports the
//    drift. This is informational only — client_price was NEVER a stored
//    column (always computed live), so there is nothing to backfill here;
//    every future view of these quotes will simply show the corrected
//    number automatically now that the code is fixed.
//
// 2. Already-activated jobs: invoice_schedule rows ARE persisted, real data,
//    written once at activation time using whatever formula was live then.
//    A job activated before this fix has invoice_schedule.amount values
//    baked in from the old blanket formula — this fix does NOT and MUST NOT
//    retroactively rewrite them (per the "do not silently rewrite historical
//    quotes" requirement). This script only reports which activated jobs
//    have a stored invoice_schedule total that no longer matches what the
//    canonical calculation would produce today, so a human can decide
//    whether/how to reconcile those specific contracts — never automatic.
//
// Explicitly does NOT touch: pricing_source, unresolved-item classification,
// or anything from the earlier pricing-lifecycle/pricing-source workstreams
// — those are separate, already-scoped investigations. This script is
// margin-reconciliation only.
//
// Usage:
//   NEXT_PUBLIC_SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
//     node --experimental-strip-types scripts/dev-audit-margin-reconciliation.mjs \
//       [--quote-id=<uuid>]   # optional: scope to one quote instead of all
// ============================================================

import { createClient } from '@supabase/supabase-js'
import { applyMargin, calculateClientPrice } from '../lib/pricing.ts'

const args = Object.fromEntries(
  process.argv.slice(2).map((a) => {
    const [k, ...rest] = a.replace(/^--/, '').split('=')
    return [k, rest.join('=')]
  })
)

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY
if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
const money = (n) => `$${Math.round(n ?? 0).toLocaleString('en-AU')}`

async function main() {
  let quoteQuery = supabase.from('quotes').select('id, job_id, status, total_cost, margin_pct')
  if (args['quote-id']) quoteQuery = quoteQuery.eq('id', args['quote-id'])
  const { data: quotes, error: quotesErr } = await quoteQuery
  if (quotesErr) throw new Error(`Could not load quotes: ${quotesErr.message}`)

  console.log('='.repeat(72))
  console.log('MARGIN RECONCILIATION AUDIT — dry run, zero database writes')
  console.log('='.repeat(72))
  console.log(`Quotes scanned: ${(quotes ?? []).length}`)

  // ── Part 1: quotes — informational, nothing to backfill ────────────────
  const quoteFindings = []
  for (const q of quotes ?? []) {
    if (q.total_cost === null || q.margin_pct === null) continue
    const { data: items } = await supabase
      .from('quote_line_items')
      .select('total, margin_pct, assumption_status')
      .eq('quote_id', q.id)
    const canonical = calculateClientPrice(items ?? [])
    const blanket = applyMargin(q.total_cost, q.margin_pct)
    const drift = Math.round(Math.abs(canonical - blanket) * 100) / 100
    if (drift > 1) {
      quoteFindings.push({ quote_id: q.id, job_id: q.job_id, status: q.status, canonical, blanket, drift })
    }
  }

  console.log('\n' + '-'.repeat(72))
  console.log(`PART 1 — QUOTES WHERE THE DISPLAYED client_price WILL CHANGE (${quoteFindings.length} affected)`)
  console.log('-'.repeat(72))
  console.log('Informational only — client_price is computed live, never stored, so')
  console.log('nothing needs to be written. The next time each of these is viewed, sent,')
  console.log('or exported, it will show the CORRECTED (canonical) figure automatically.')
  let totalQuoteDriftValue = 0
  for (const f of quoteFindings) {
    totalQuoteDriftValue += f.drift
    console.log(`\nQuote ${f.quote_id}  (job ${f.job_id}, status=${f.status})`)
    console.log(`  Old blanket formula:  ${money(f.blanket)}`)
    console.log(`  New canonical:        ${money(f.canonical)}`)
    console.log(`  Drift:                ${money(f.drift)}`)
    if (f.status === 'sent' || f.status === 'approved') {
      console.log(`  NOTE: this quote's status is '${f.status}' — an email/PDF with the OLD`)
      console.log(`  (${money(f.blanket)}) figure may already have been sent to a client.`)
      console.log(`  This script does not know whether that already happened; a human should`)
      console.log(`  check this specific quote's send history before assuming it's still safe.`)
    }
  }
  console.log(`\nTotal quotes affected: ${quoteFindings.length}`)
  console.log(`Sum of |drift| across affected quotes: ${money(totalQuoteDriftValue)}`)

  // ── Part 2: already-activated jobs — real, persisted invoice_schedule rows ─
  const { data: activatedJobs, error: jobsErr } = await supabase
    .from('jobs')
    .select('id, address, status')
    .eq('status', 'active')
  if (jobsErr) throw new Error(`Could not load jobs: ${jobsErr.message}`)

  const invoiceFindings = []
  for (const job of activatedJobs ?? []) {
    const { data: invoiceRows } = await supabase
      .from('invoice_schedule')
      .select('amount')
      .eq('job_id', job.id)
    if (!invoiceRows || invoiceRows.length === 0) continue
    const storedTotal = Math.round(invoiceRows.reduce((sum, r) => sum + (r.amount ?? 0), 0) * 100) / 100

    // The quote this job was activated from — best-effort lookup (approved
    // quote for this job); if none is found, this job's invoice schedule
    // can't be reconciled against a current quote and is reported as such,
    // not guessed at.
    const { data: approvedQuote } = await supabase
      .from('quotes')
      .select('id, total_cost, margin_pct')
      .eq('job_id', job.id)
      .eq('status', 'approved')
      .order('approved_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (!approvedQuote || approvedQuote.total_cost === null) {
      invoiceFindings.push({ job_id: job.id, address: job.address, storedTotal, canonicalToday: null, note: 'No approved quote found to reconcile against.' })
      continue
    }
    const { data: items } = await supabase
      .from('quote_line_items')
      .select('total, margin_pct, assumption_status')
      .eq('quote_id', approvedQuote.id)
    const canonicalToday = calculateClientPrice(items ?? [])
    const drift = Math.round(Math.abs(storedTotal - canonicalToday) * 100) / 100
    if (drift > 1) {
      invoiceFindings.push({ job_id: job.id, address: job.address, storedTotal, canonicalToday, drift })
    }
  }

  console.log('\n' + '='.repeat(72))
  console.log(`PART 2 — ACTIVATED JOBS WITH A STORED invoice_schedule THAT NO LONGER MATCHES (${invoiceFindings.length} affected)`)
  console.log('='.repeat(72))
  console.log('These are REAL, ALREADY-PERSISTED rows — not recomputed by this fix, and')
  console.log('NOT rewritten by this script. Reported for a human decision only:')
  let totalInvoiceDriftValue = 0
  for (const f of invoiceFindings) {
    console.log(`\nJob ${f.job_id}  (${f.address})`)
    console.log(`  Stored invoice_schedule total:     ${money(f.storedTotal)}`)
    if (f.canonicalToday !== null) {
      console.log(`  What canonical calc gives today:   ${money(f.canonicalToday)}`)
      console.log(`  Drift:                              ${money(f.drift)}`)
      totalInvoiceDriftValue += f.drift
    } else {
      console.log(`  ${f.note}`)
    }
  }
  console.log(`\nTotal activated jobs affected: ${invoiceFindings.length}`)
  console.log(`Sum of |drift| across affected invoice schedules: ${money(totalInvoiceDriftValue)}`)

  console.log('\n' + '='.repeat(72))
  console.log(JSON.stringify({
    event: 'margin_reconciliation_audit_complete',
    quotes_scanned: (quotes ?? []).length,
    quotes_affected: quoteFindings.length,
    quotes_total_drift: totalQuoteDriftValue,
    activated_jobs_scanned: (activatedJobs ?? []).length,
    activated_jobs_affected: invoiceFindings.length,
    activated_jobs_total_drift: totalInvoiceDriftValue,
  }, null, 2))
}

main().catch((err) => {
  console.error(JSON.stringify({ event: 'margin_reconciliation_audit_failed', error: err instanceof Error ? err.message : String(err) }))
  process.exit(1)
})
