import { NextRequest, NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { getContractValueForJob, generateInvoiceNumber, wouldExceedContractValue, computeInvoiceTotals } from '@/lib/invoices'
import { recordProofEvent } from '@/lib/proof'

// ─── GET/POST /api/jobs/[jobId]/invoices ───────────────────────────────────
//
// Invoicing v1 — Real Cash Tracking. `invoices` is the canonical invoice
// entity (see migration 099's header comment); `invoice_schedule` is the
// billing plan a real invoice can optionally be created from. Ownership is
// checked explicitly against the jobs table on every request, matching the
// pattern already established by costs/variations — the jobId route param
// alone proves nothing.

interface CreateBody {
  description?: string
  amount?: number
  due_date?: string | null
  schedule_id?: string
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function isValidDateString(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime())
}

async function jobOwnedByBuilder(
  supabase: SupabaseClient,
  jobId: string,
  builderId: string
): Promise<boolean> {
  const { data } = await supabase.from('jobs').select('id').eq('id', jobId).eq('builder_id', builderId).single()
  return !!data
}

// ─── GET ───────────────────────────────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ invoices: [], schedule: [], contract_value: null, invoiced: 0, paid: 0, outstanding: 0 })
  }

  const { jobId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

    if (!(await jobOwnedByBuilder(supabase, jobId, builderId))) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const [{ data: invoices, error: invErr }, { data: schedule }, contractValue] = await Promise.all([
      supabase
        .from('invoices')
        .select('id, description, invoice_number, amount, status, due_date, sent_at, paid_at, created_at')
        .eq('job_id', jobId)
        .order('created_at', { ascending: false }),
      supabase
        .from('invoice_schedule')
        .select('id, label, percentage, amount, due_trigger, invoice_id')
        .eq('job_id', jobId)
        .order('created_at', { ascending: true }),
      getContractValueForJob(supabase, jobId),
    ])

    if (invErr) {
      return NextResponse.json({ error: invErr.message }, { status: 500 })
    }

    const totals = computeInvoiceTotals(invoices ?? [])

    return NextResponse.json({
      invoices: invoices ?? [],
      schedule: schedule ?? [],
      contract_value: contractValue,
      ...totals,
    })
  } catch (err) {
    console.error('[jobs/invoices:get] error:', err)
    return NextResponse.json({ error: 'Failed to load invoices. Please try again.' }, { status: 500 })
  }
}

// ─── POST ──────────────────────────────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  let body: CreateBody
  try {
    body = (await req.json()) as CreateBody
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { jobId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

    if (!(await jobOwnedByBuilder(supabase, jobId, builderId))) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    let description = typeof body.description === 'string' ? body.description.trim() : ''
    let amount = typeof body.amount === 'number' ? body.amount : NaN
    let dueDate: string | null = null

    // Creating from a schedule stage pre-fills description/amount from the
    // plan — the builder can still override amount below. The schedule row
    // itself has no date (only a due_trigger description, e.g. "On contract
    // signing") — a real due_date is always builder-entered, never derived.
    let scheduleRow: { id: string; label: string; amount: number; invoice_id: string | null } | null = null
    if (body.schedule_id) {
      const { data: schedule } = await supabase
        .from('invoice_schedule')
        .select('id, label, amount, invoice_id')
        .eq('id', body.schedule_id)
        .eq('job_id', jobId)
        .eq('builder_id', builderId)
        .maybeSingle()

      if (!schedule) {
        return NextResponse.json({ error: 'Schedule stage not found' }, { status: 404 })
      }
      if (schedule.invoice_id) {
        return NextResponse.json({ error: 'This stage has already been invoiced.' }, { status: 409 })
      }
      scheduleRow = schedule
      if (!description) description = schedule.label
      if (Number.isNaN(amount)) amount = schedule.amount
    }

    if (!description) {
      return NextResponse.json({ error: 'Description is required' }, { status: 400 })
    }
    if (!Number.isFinite(amount) || amount <= 0) {
      return NextResponse.json({ error: 'Amount must be a number greater than 0' }, { status: 400 })
    }
    amount = round2(amount)

    if (body.due_date !== undefined && body.due_date !== null) {
      if (typeof body.due_date !== 'string' || !isValidDateString(body.due_date)) {
        return NextResponse.json({ error: 'due_date must be a valid date (YYYY-MM-DD)' }, { status: 400 })
      }
      dueDate = body.due_date
    }

    const [contractValue, { data: existingInvoices }] = await Promise.all([
      getContractValueForJob(supabase, jobId),
      supabase.from('invoices').select('id, amount').eq('job_id', jobId),
    ])

    if (wouldExceedContractValue(existingInvoices ?? [], amount, contractValue)) {
      return NextResponse.json(
        {
          error: `This invoice would bring total invoiced to more than the current contract value${
            contractValue !== null ? ` of $${contractValue.toLocaleString('en-AU')}` : ''
          }.`,
        },
        { status: 422 }
      )
    }

    const invoiceNumber = await generateInvoiceNumber(supabase, jobId)

    const { data: inserted, error: insertErr } = await supabase
      .from('invoices')
      .insert({
        job_id: jobId,
        builder_id: builderId,
        description,
        invoice_number: invoiceNumber,
        amount,
        due_date: dueDate,
        status: 'draft',
      })
      .select('id, description, invoice_number, amount, status, due_date, sent_at, paid_at, created_at')
      .single()

    if (insertErr) {
      if ((insertErr as { code?: string }).code === '23505') {
        return NextResponse.json({ error: 'A duplicate invoice reference was generated — please try again.' }, { status: 409 })
      }
      return NextResponse.json({ error: insertErr.message }, { status: 500 })
    }

    if (scheduleRow) {
      // Atomic: only links if still unclaimed at this exact moment — the
      // durable idempotency guard against a race, same pattern as
      // applyApprovedVariationToQuote (lib/variations.ts).
      const { data: linked, error: linkErr } = await supabase
        .from('invoice_schedule')
        .update({ invoice_id: inserted!.id })
        .eq('id', scheduleRow.id)
        .is('invoice_id', null)
        .select('id')
        .maybeSingle()

      if (linkErr || !linked) {
        // Lost the race — compensate by removing the invoice we just made
        // rather than leaving an orphaned duplicate of the same stage.
        await supabase.from('invoices').delete().eq('id', inserted!.id)
        return NextResponse.json({ error: 'This stage was just invoiced by another action.' }, { status: 409 })
      }
    }

    void recordProofEvent({
      jobId,
      builderId,
      eventType: 'invoice_created',
      description: `Invoice ${invoiceNumber} created — ${description} ($${amount.toLocaleString('en-AU')})`,
      metadata: { invoice_id: inserted!.id, amount, schedule_id: scheduleRow?.id ?? null },
    }).catch(() => {})

    return NextResponse.json({ invoice: inserted })
  } catch (err) {
    console.error('[jobs/invoices:post] error:', err)
    return NextResponse.json({ error: 'Failed to create invoice — please try again.' }, { status: 500 })
  }
}
