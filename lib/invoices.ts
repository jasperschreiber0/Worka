// ─── Invoicing v1 — Real Cash Tracking ──────────────────────────────────────
//
// Shared helpers used by both invoice API routes and the job snapshot route,
// so "what does contract value / invoiced / paid / outstanding mean" is
// computed in exactly one place — never re-derived independently in React.
//
// Canonical model (see migration 099's own header comment for the full
// reasoning): `invoices` is the authoritative invoice entity (status
// lifecycle, due_date, sent_at, paid_at — all pre-existing). `invoice_schedule`
// stays what it already was — a billing plan a real invoice can optionally be
// created from, linked via the pre-existing invoice_schedule.invoice_id FK.
//
// Relative, .ts-suffixed import — same reason pricing.test.ts/variations.ts
// document: files under lib/ that need to run identically under plain
// `node --experimental-strip-types` and under Next.js/webpack must use this
// import style for sibling lib/ files.
import { calculateClientPrice, type SellPriceableItem } from './pricing.ts'

export interface InvoiceRow {
  id: string
  amount: number
  status: 'draft' | 'sent' | 'overdue' | 'paid'
}

/**
 * Overdue is derived at read time, never stored (see migration 099's own
 * comment) — a sent invoice past its due date is overdue right now, not
 * whenever a cron last ran. The ONE place this is computed — both the
 * invoices list route and the job snapshot route call this, so they can
 * never disagree on a given invoice's displayed status.
 */
export function deriveInvoiceStatus(invoice: { status: string; due_date: string | null }): 'draft' | 'sent' | 'overdue' | 'paid' {
  if (invoice.status === 'sent' && invoice.due_date != null && new Date(invoice.due_date).getTime() < Date.now()) {
    return 'overdue'
  }
  return invoice.status as 'draft' | 'sent' | 'overdue' | 'paid'
}

/** Applies deriveInvoiceStatus across a list, returning new objects (never mutates input). */
export function withDerivedStatus<T extends { status: string; due_date: string | null }>(invoices: T[]): T[] {
  return invoices.map((inv) => ({ ...inv, status: deriveInvoiceStatus(inv) }))
}

export interface InvoiceTotals {
  invoiced: number
  paid: number
  outstanding: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/**
 * invoiced = sum of issued invoices (sent or paid), excluding drafts — a
 * draft is not yet a commitment to the client, so it must not move any of
 * these three figures. 'overdue' is included defensively even though the
 * app never stores it (see migration 099's comment) — an overdue invoice is
 * still an issued one.
 * paid = sum of invoices actually marked paid.
 * outstanding = invoiced - paid — money billed but not yet collected. This
 * is deliberately NOT (contract value - paid): an un-invoiced portion of the
 * contract isn't "outstanding" in the accounts-receivable sense — the
 * builder hasn't billed for it yet, so there's nothing to chase.
 */
export function computeInvoiceTotals(invoices: InvoiceRow[]): InvoiceTotals {
  const invoiced = round2(
    invoices
      .filter((i) => i.status === 'sent' || i.status === 'overdue' || i.status === 'paid')
      .reduce((sum, i) => sum + i.amount, 0)
  )
  const paid = round2(invoices.filter((i) => i.status === 'paid').reduce((sum, i) => sum + i.amount, 0))
  return { invoiced, paid, outstanding: round2(invoiced - paid) }
}

/**
 * The job's current contract value, via the same canonical calculation
 * (calculateClientPrice) and the job's canonical current quote —
 * quotes.is_current (migration 061), the DB-enforced, exactly-one-per-job
 * marker every quote-creation call site (Stage 6, the estimate route,
 * revise) already keeps in sync via set_current_quote(). Round 11
 * reliability audit: this used to select "highest version, no status
 * filter, no tiebreak" instead, which could pick a different quote than
 * is_current — and therefore than the snapshot route and
 * applyApprovedVariationToQuote (lib/variations.ts) — whenever a job ended
 * up with more than one quote sharing the top version.
 */
export async function getContractValueForJob(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  jobId: string
): Promise<number | null> {
  const { data: quote } = await supabase
    .from('quotes')
    .select('id')
    .eq('job_id', jobId)
    .eq('is_current', true)
    .maybeSingle()

  if (!quote) return null

  const { data: lineItems } = await supabase
    .from('quote_line_items')
    .select('total, margin_pct, assumption_status')
    .eq('quote_id', quote.id)

  return calculateClientPrice((lineItems ?? []) as SellPriceableItem[])
}

/**
 * Smallest deterministic per-job reference mechanism the brief asked for —
 * not a global sequence, not a settings/numbering system. Scoped to the job,
 * computed from the count of invoices already on it. A genuinely concurrent
 * double-create on the same job (two rapid clicks) could in theory compute
 * the same number twice; the partial unique index on
 * (job_id, invoice_number) — migration 099 — is the backstop that turns that
 * into a clean, retriable 409 rather than silent duplicate numbering.
 */
export async function generateInvoiceNumber(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  jobId: string
): Promise<string> {
  const { count } = await supabase
    .from('invoices')
    .select('id', { count: 'exact', head: true })
    .eq('job_id', jobId)
  return `INV-${(count ?? 0) + 1}`
}

/**
 * Guards against total invoiced (draft + sent + paid — every invoice that
 * currently represents an intent to bill some portion of the contract, not
 * just already-sent ones) exceeding the job's live contract value through
 * normal workflow. `excludeInvoiceId` lets an edit re-check itself without
 * double-counting its own prior amount.
 */
export function wouldExceedContractValue(
  existingInvoices: Array<{ id: string; amount: number }>,
  newAmount: number,
  contractValue: number | null,
  excludeInvoiceId?: string
): boolean {
  if (contractValue === null) return false // no quote yet — nothing to cap against
  const existingSum = existingInvoices
    .filter((i) => i.id !== excludeInvoiceId)
    .reduce((sum, i) => sum + i.amount, 0)
  return round2(existingSum + newAmount) > round2(contractValue) + 0.01 // cent-level rounding slack
}
