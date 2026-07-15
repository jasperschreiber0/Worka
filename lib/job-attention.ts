// Dashboard-feed bucket computation — "what does this job need from the
// builder right now". Deliberately separate from app/api/chat/route.ts's
// computeJobAttention(), which buckets jobs for the chat job-list picker
// using a different taxonomy (needs_you / waiting / ai_working / ready /
// in_progress) built around quoting-pipeline stage. This one is built
// around operational urgency across the whole job lifecycle and mirrors
// the brief's five buckets. They intentionally stay separate — merging
// them would force one taxonomy to serve two different questions — but
// both read the same underlying real rows (invoices, variations, quotes).
//
// Every bucket here is backed by a real column. The one exception is
// 'waiting_supplier': there is no supplier-tracking table anywhere in the
// schema (the only supplier-adjacent logic in the app is a keyword scan
// over already-generated alert text in MorningBriefCard). So this bucket
// is real in shape but is never populated in real mode — documented here
// rather than faked with a heuristic.

import type { SupabaseClient } from '@supabase/supabase-js'

export type JobBucket = 'overdue' | 'due_today' | 'waiting_client' | 'waiting_supplier' | 'ready_invoice'

export const BUCKET_LABEL: Record<JobBucket, string> = {
  overdue: '🔴 Overdue',
  due_today: '🟠 Due Today',
  waiting_client: '🟡 Waiting on Client',
  waiting_supplier: '🔵 Waiting on Supplier',
  ready_invoice: '🟢 Ready to Invoice',
}

// Render/severity order — also the order feed sections appear in.
export const BUCKET_ORDER: JobBucket[] = ['overdue', 'due_today', 'waiting_client', 'waiting_supplier', 'ready_invoice']

export interface JobFeedAttention {
  bucket: JobBucket
  ai_reasoning: string
  primary_action: string
  secondary_action?: string
}

interface FeedJob {
  id: string
  address: string
  status: string
}

export async function computeJobFeedAttention(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sb: SupabaseClient<any>,
  jobs: FeedJob[]
): Promise<Map<string, JobFeedAttention>> {
  const result = new Map<string, JobFeedAttention>()
  const jobIds = jobs.map(j => j.id)
  if (jobIds.length === 0) return result

  const todayStr = new Date().toISOString().split('T')[0]

  const [{ data: invoices }, { data: quotes }, { data: schedule }, { data: variations }] = await Promise.all([
    sb.from('invoices').select('job_id, status, due_date, amount').in('job_id', jobIds),
    sb.from('quotes').select('job_id, status, sent_at, version').in('job_id', jobIds).order('version', { ascending: false }),
    sb.from('invoice_schedule').select('job_id, invoice_id, amount, label').in('job_id', jobIds),
    sb.from('variations').select('job_id').eq('status', 'pending').in('job_id', jobIds),
  ])

  type InvoiceRow = { job_id: string; status: string; due_date: string | null; amount: number }
  type QuoteRow = { job_id: string; status: string; sent_at: string | null; version: number }
  type ScheduleRow = { job_id: string; invoice_id: string | null; amount: number; label: string }

  const invoicesByJob = new Map<string, InvoiceRow[]>()
  for (const inv of (invoices ?? []) as InvoiceRow[]) {
    if (!invoicesByJob.has(inv.job_id)) invoicesByJob.set(inv.job_id, [])
    invoicesByJob.get(inv.job_id)!.push(inv)
  }

  const latestQuoteByJob = new Map<string, QuoteRow>()
  for (const q of (quotes ?? []) as QuoteRow[]) {
    if (!latestQuoteByJob.has(q.job_id)) latestQuoteByJob.set(q.job_id, q)
  }

  const scheduleByJob = new Map<string, ScheduleRow[]>()
  for (const s of (schedule ?? []) as ScheduleRow[]) {
    if (!scheduleByJob.has(s.job_id)) scheduleByJob.set(s.job_id, [])
    scheduleByJob.get(s.job_id)!.push(s)
  }

  const jobsWithPendingVariation = new Set(((variations ?? []) as Array<{ job_id: string }>).map(v => v.job_id))

  for (const job of jobs) {
    const addr = job.address?.split(',')[0] ?? 'This job'
    const jobInvoices = invoicesByJob.get(job.id) ?? []
    const quote = latestQuoteByJob.get(job.id)
    const scheduleRows = scheduleByJob.get(job.id) ?? []

    // Mirrors the morning-brief edge function's definition: an invoice is
    // overdue if it's been sent (or already flagged 'overdue') and its due
    // date has passed — nothing in this codebase writes a literal
    // status='overdue' row on its own, so checking status alone would miss
    // every invoice that's simply gone past its due date while still 'sent'.
    const overdueInvoice = jobInvoices.find(
      i => (i.status === 'sent' || i.status === 'overdue') && i.due_date !== null && i.due_date < todayStr
    )
    if (overdueInvoice) {
      result.set(job.id, {
        bucket: 'overdue',
        ai_reasoning: `${addr} — $${Number(overdueInvoice.amount).toLocaleString('en-AU')} invoice is overdue.`,
        primary_action: 'Send payment chaser',
        secondary_action: 'Open job',
      })
      continue
    }

    const dueTodayInvoice = jobInvoices.find(i => (i.status === 'sent' || i.status === 'overdue') && i.due_date === todayStr)
    if (dueTodayInvoice) {
      result.set(job.id, {
        bucket: 'due_today',
        ai_reasoning: `${addr} — $${Number(dueTodayInvoice.amount).toLocaleString('en-AU')} invoice is due today.`,
        primary_action: 'Send reminder',
        secondary_action: 'Open job',
      })
      continue
    }

    if (jobsWithPendingVariation.has(job.id)) {
      result.set(job.id, {
        bucket: 'waiting_client',
        ai_reasoning: `${addr} — a variation is waiting on client approval.`,
        primary_action: 'Review variation',
        secondary_action: 'Open job',
      })
      continue
    }

    if (quote?.status === 'sent' && quote.sent_at) {
      const daysSince = Math.floor((Date.now() - new Date(quote.sent_at).getTime()) / (1000 * 60 * 60 * 24))
      result.set(job.id, {
        bucket: 'waiting_client',
        ai_reasoning: daysSince > 0
          ? `${addr} — quote sent ${daysSince} day${daysSince !== 1 ? 's' : ''} ago, no response yet.`
          : `${addr} — quote sent today, awaiting response.`,
        primary_action: daysSince >= 5 ? 'Follow up now' : 'Follow up',
        secondary_action: 'Open job',
      })
      continue
    }

    const unclaimedSchedule = scheduleRows.find(s => !s.invoice_id)
    if (job.status === 'active' && unclaimedSchedule) {
      result.set(job.id, {
        bucket: 'ready_invoice',
        ai_reasoning: `${addr} — "${unclaimedSchedule.label}" ($${Number(unclaimedSchedule.amount).toLocaleString('en-AU')}) is scheduled and not yet invoiced.`,
        primary_action: 'Send invoice',
        secondary_action: 'Open job',
      })
      continue
    }
    // No bucket — job has nothing needing builder attention right now.
  }

  return result
}
