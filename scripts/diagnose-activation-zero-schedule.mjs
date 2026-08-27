#!/usr/bin/env node
// ============================================================
// Diagnostic only, NOT part of any milestone — read-only, platform-wide
// production check for the job-activation zero-value invoice-schedule
// defect (Round 9 reliability audit finding).
//
// Looks for the exact gap this fix closes: an active job whose
// invoice_schedule rows sum to $0 while its approved quote's line items
// (the same clientContractValue calculation activate/route.ts uses) sum to
// a genuinely non-zero contract value -- the shape a pre-fix transient
// read failure during activation left behind, permanently (planActivationRepair
// used to see scheduleCount>0 and report the job fully activated already).
//
// Read-only. Modifies nothing. Reports the exact count and IDs -- does not
// repair anything.
//
// Usage: node scripts/diagnose-activation-zero-schedule.mjs
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

  const { data: activeJobs, error: jobsErr } = await supabase
    .from('jobs')
    .select('id, address, builder_id')
    .eq('status', 'active')

  if (jobsErr) {
    console.error(JSON.stringify({ event: 'jobs_query_failed', error: jobsErr.message }))
    process.exit(1)
  }

  const jobs = activeJobs ?? []
  console.log(JSON.stringify({ event: 'active_jobs_count', count: jobs.length }))

  if (jobs.length === 0) {
    console.log(JSON.stringify({ event: 'run_complete', poisoned_count: 0 }))
    return
  }

  const jobIds = jobs.map((j) => j.id)
  const CHUNK = 200

  const scheduleTotalByJob = new Map()
  const scheduleHasLinkedInvoiceByJob = new Map()
  for (let i = 0; i < jobIds.length; i += CHUNK) {
    const chunk = jobIds.slice(i, i + CHUNK)
    const { data: scheduleRows, error: scheduleErr } = await supabase
      .from('invoice_schedule')
      .select('job_id, amount, invoice_id')
      .in('job_id', chunk)
    if (scheduleErr) {
      console.error(JSON.stringify({ event: 'invoice_schedule_query_failed', error: scheduleErr.message }))
      process.exit(1)
    }
    for (const row of scheduleRows ?? []) {
      scheduleTotalByJob.set(row.job_id, (scheduleTotalByJob.get(row.job_id) ?? 0) + (row.amount ?? 0))
      if (row.invoice_id !== null) scheduleHasLinkedInvoiceByJob.set(row.job_id, true)
    }
  }

  // Jobs whose schedule sums to exactly 0 (and have at least one row --
  // scheduleTotalByJob only has entries for jobs with rows, since we only
  // set it inside the loop above).
  const zeroScheduleJobIds = jobIds.filter((id) => scheduleTotalByJob.has(id) && scheduleTotalByJob.get(id) === 0)
  console.log(JSON.stringify({ event: 'zero_total_schedule_jobs_count', count: zeroScheduleJobIds.length }))

  if (zeroScheduleJobIds.length === 0) {
    console.log(JSON.stringify({ event: 'run_complete', poisoned_count: 0 }))
    return
  }

  // For those, find each job's current quote and compute the real contract
  // value the same way activate/route.ts does (calculateClientPrice over
  // quote_line_items) to confirm it's genuinely non-zero -- not a
  // legitimate $0 contract.
  const { data: currentQuotes, error: quotesErr } = await supabase
    .from('quotes')
    .select('id, job_id, builder_id')
    .in('job_id', zeroScheduleJobIds)
    .eq('is_current', true)

  if (quotesErr) {
    console.error(JSON.stringify({ event: 'quotes_query_failed', error: quotesErr.message }))
    process.exit(1)
  }

  const quoteByJob = new Map((currentQuotes ?? []).map((q) => [q.job_id, q]))

  const poisoned = []
  for (const jobId of zeroScheduleJobIds) {
    const quote = quoteByJob.get(jobId)
    if (!quote) continue // no current quote to compute a contract value from -- skip, not this defect's shape

    if (scheduleHasLinkedInvoiceByJob.get(jobId)) continue // a real invoice already depends on a row here -- never this defect's shape (a $0 stage can't have been invoiced)

    const { data: lineItems, error: lineItemsErr } = await supabase
      .from('quote_line_items')
      .select('total, margin_pct, assumption_status')
      .eq('quote_id', quote.id)

    if (lineItemsErr) {
      console.error(JSON.stringify({ event: 'line_items_query_failed', job_id: jobId, error: lineItemsErr.message }))
      continue
    }

    const included = (lineItems ?? []).filter((i) => i.assumption_status !== 'excluded')
    const contractValue = Math.round(included.reduce((sum, i) => {
      const marginPct = i.margin_pct ?? 0
      const total = i.total ?? 0
      return sum + total * (1 + marginPct)
    }, 0) * 100) / 100

    if (contractValue > 0) {
      poisoned.push({ job_id: jobId, builder_id: quote.builder_id, quote_id: quote.id, contract_value: contractValue })
    }
  }

  console.log(JSON.stringify({
    event: 'poisoned_zero_schedule_jobs',
    description: 'active jobs whose invoice_schedule sums to $0 while their current quote line items sum to a non-zero contract value -- the activation zero-value-schedule defect this fix closes',
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
