import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { getContractValueForJob, wouldExceedContractValue, deriveInvoiceStatus } from '@/lib/invoices'
import { recordProofEvent } from '@/lib/proof'

// ─── PATCH/DELETE /api/jobs/[jobId]/invoices/[invoiceId] ───────────────────
//
// Invoicing v1. Every transition is an atomic, forward-only, current-status-
// guarded update — the same "only the first caller wins" pattern proven by
// variation approval (migration 098 / lib/variations.ts) and job costs.
// Lifecycle: draft --send--> sent --mark_paid--> paid --mark_unpaid--> sent.
// draft->paid directly and sent-amount edits are deliberately rejected (see
// each action below) — the milestone report explains why.

interface PatchBody {
  action?: 'send' | 'mark_paid' | 'mark_unpaid' | 'edit'
  description?: string
  amount?: number
  due_date?: string | null
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime())
}

async function jobOwnedByBuilder(supabase: SupabaseClient, jobId: string, builderId: string): Promise<boolean> {
  const { data } = await supabase.from('jobs').select('id').eq('id', jobId).eq('builder_id', builderId).single()
  return !!data
}

export async function PATCH(
  req: NextRequest,
  { params }: { params: { jobId: string; invoiceId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  let body: PatchBody
  try {
    body = (await req.json()) as PatchBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { jobId, invoiceId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

    if (!(await jobOwnedByBuilder(supabase, jobId, builderId))) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const base = supabase
      .from('invoices')
      .select('*')
      .eq('id', invoiceId)
      .eq('job_id', jobId)
      .eq('builder_id', builderId)
      .single()
    const { data: existing, error: fetchErr } = await base
    if (fetchErr || !existing) {
      return NextResponse.json({ error: 'Invoice not found' }, { status: 404 })
    }

    if (body.action === 'send') {
      const { data: updated, error } = await supabase
        .from('invoices')
        .update({ status: 'sent', sent_at: new Date().toISOString() })
        .eq('id', invoiceId)
        .eq('builder_id', builderId)
        .eq('status', 'draft')
        .select('id, description, invoice_number, amount, status, due_date, sent_at, paid_at, created_at')
        .maybeSingle()

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!updated) {
        return NextResponse.json({ error: 'Only a draft invoice can be marked sent.' }, { status: 422 })
      }

      void recordProofEvent({
        jobId,
        builderId,
        eventType: 'invoice_sent',
        description: `Invoice ${updated.invoice_number ?? invoiceId} marked sent ($${updated.amount.toLocaleString('en-AU')})`,
        metadata: { invoice_id: invoiceId },
      }).catch(() => {})

      return NextResponse.json({ invoice: { ...updated, status: deriveInvoiceStatus(updated) } })
    }

    if (body.action === 'mark_paid') {
      // draft->paid directly is deliberately rejected: an invoice must be
      // sent before it can be collected — "paid" means the client actually
      // paid a real, issued invoice, not a note that was never sent.
      const { data: updated, error } = await supabase
        .from('invoices')
        .update({ status: 'paid', paid_at: new Date().toISOString() })
        .eq('id', invoiceId)
        .eq('builder_id', builderId)
        .eq('status', 'sent')
        .select('id, description, invoice_number, amount, status, due_date, sent_at, paid_at, created_at')
        .maybeSingle()

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!updated) {
        return NextResponse.json({ error: 'Only a sent invoice can be marked paid.' }, { status: 422 })
      }

      void recordProofEvent({
        jobId,
        builderId,
        eventType: 'invoice_paid',
        description: `Invoice ${updated.invoice_number ?? invoiceId} marked paid ($${updated.amount.toLocaleString('en-AU')})`,
        metadata: { invoice_id: invoiceId },
      }).catch(() => {})

      return NextResponse.json({ invoice: { ...updated, status: deriveInvoiceStatus(updated) } })
    }

    if (body.action === 'mark_unpaid') {
      // A deliberate, safe reversal for a mis-click: clears paid_at, returns
      // to 'sent' (sent_at is untouched — the invoice was genuinely sent).
      // No data is destroyed; this is why it's allowed while other reverse
      // transitions (e.g. sent->draft) are not.
      const { data: updated, error } = await supabase
        .from('invoices')
        .update({ status: 'sent', paid_at: null })
        .eq('id', invoiceId)
        .eq('builder_id', builderId)
        .eq('status', 'paid')
        .select('id, description, invoice_number, amount, status, due_date, sent_at, paid_at, created_at')
        .maybeSingle()

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!updated) {
        return NextResponse.json({ error: 'Only a paid invoice can be marked unpaid.' }, { status: 422 })
      }

      void recordProofEvent({
        jobId,
        builderId,
        eventType: 'invoice_marked_unpaid',
        description: `Invoice ${updated.invoice_number ?? invoiceId} reverted to sent (marked unpaid)`,
        metadata: { invoice_id: invoiceId },
      }).catch(() => {})

      return NextResponse.json({ invoice: { ...updated, status: deriveInvoiceStatus(updated) } })
    }

    if (body.action === 'edit') {
      // Draft-only, matching the brief's conservative rule: sent invoices
      // can be marked paid but not casually re-amounted; paid ones are
      // immutable financial records.
      if (existing.status !== 'draft') {
        return NextResponse.json({ error: 'Only a draft invoice can be edited.' }, { status: 422 })
      }

      const patch: Record<string, unknown> = {}
      if (body.description !== undefined) {
        const description = typeof body.description === 'string' ? body.description.trim() : ''
        if (!description) return NextResponse.json({ error: 'Description is required' }, { status: 400 })
        patch.description = description
      }
      let newAmount = existing.amount as number
      if (body.amount !== undefined) {
        if (typeof body.amount !== 'number' || !Number.isFinite(body.amount) || body.amount <= 0) {
          return NextResponse.json({ error: 'Amount must be a number greater than 0' }, { status: 400 })
        }
        newAmount = round2(body.amount)
        patch.amount = newAmount
      }
      if (body.due_date !== undefined) {
        if (body.due_date !== null && (typeof body.due_date !== 'string' || !isValidDateString(body.due_date))) {
          return NextResponse.json({ error: 'due_date must be a valid date (YYYY-MM-DD)' }, { status: 400 })
        }
        patch.due_date = body.due_date
      }

      if (body.amount !== undefined) {
        const [contractValue, { data: existingInvoices }] = await Promise.all([
          getContractValueForJob(supabase, jobId),
          supabase.from('invoices').select('id, amount').eq('job_id', jobId),
        ])
        if (wouldExceedContractValue(existingInvoices ?? [], newAmount, contractValue, invoiceId)) {
          return NextResponse.json(
            { error: 'This change would bring total invoiced above the current contract value.' },
            { status: 422 }
          )
        }
      }

      const { data: updated, error } = await supabase
        .from('invoices')
        .update(patch)
        .eq('id', invoiceId)
        .eq('builder_id', builderId)
        .eq('status', 'draft')
        .select('id, description, invoice_number, amount, status, due_date, sent_at, paid_at, created_at')
        .maybeSingle()

      if (error) return NextResponse.json({ error: error.message }, { status: 500 })
      if (!updated) {
        return NextResponse.json({ error: 'Only a draft invoice can be edited.' }, { status: 422 })
      }

      return NextResponse.json({ invoice: { ...updated, status: deriveInvoiceStatus(updated) } })
    }

    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  } catch (err) {
    console.error('[jobs/invoices/[invoiceId]:patch] error:', err)
    return NextResponse.json({ error: 'Failed to update invoice — please try again.' }, { status: 500 })
  }
}

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { jobId: string; invoiceId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  const { jobId, invoiceId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

    if (!(await jobOwnedByBuilder(supabase, jobId, builderId))) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // Draft-only, and scoped to builder_id+job_id — cannot delete another
    // builder's or another job's invoice via this route regardless of what
    // invoiceId is passed.
    const { data: deleted, error } = await supabase
      .from('invoices')
      .delete()
      .eq('id', invoiceId)
      .eq('job_id', jobId)
      .eq('builder_id', builderId)
      .eq('status', 'draft')
      .select('id')
      .maybeSingle()

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    if (!deleted) {
      return NextResponse.json({ error: 'Only a draft invoice can be deleted.' }, { status: 422 })
    }

    // Best-effort: free up the schedule stage this invoice was created from,
    // if any, so it can be invoiced again.
    await supabase.from('invoice_schedule').update({ invoice_id: null }).eq('invoice_id', invoiceId)

    return NextResponse.json({ deleted: true })
  } catch (err) {
    console.error('[jobs/invoices/[invoiceId]:delete] error:', err)
    return NextResponse.json({ error: 'Failed to delete invoice — please try again.' }, { status: 500 })
  }
}
