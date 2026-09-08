// Authentication and connection state must be evaluated for every request.
export const dynamic = 'force-dynamic'

import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

const DEMO_ITEMS = [
  { id: 'demo-xero-1', item_type: 'bill', description: 'ABC Plumbing · Bill 1048', amount: 4300, item_date: '2026-09-03', job_id: null, status: 'unmatched' },
  { id: 'demo-xero-2', item_type: 'invoice', description: 'Hendersons · Invoice 22', amount: 28000, item_date: '2026-09-01', job_id: '00000000-0000-0000-0000-000000000010', status: 'mapped' },
  { id: 'demo-xero-3', item_type: 'contact', description: 'Tom Caruso', amount: null, item_date: null, job_id: null, status: 'unmatched' },
]

export async function GET() {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (process.env.XERO_ENABLED !== 'true') return NextResponse.json({ disabled: true, message: 'Xero is not enabled for this release.' }, { status: 503 })
  if (isDemoMode()) return NextResponse.json({ items: DEMO_ITEMS.map(item => ({ ...item, suggested_job_id: item.id === 'demo-xero-1' ? '00000000-0000-0000-0000-000000000010' : null, suggestion_reason: item.id === 'demo-xero-1' ? 'Description matches the Fitzroy job.' : null, suggestion_confidence: item.id === 'demo-xero-1' ? 0.92 : null })), demo: true })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ items: [] })
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data, error } = await sb.from('xero_import_items').select('id, item_type, description, amount, item_date, job_id, status').eq('builder_id', builderId).in('status', ['unmatched', 'mapped']).order('created_at', { ascending: false })
  if (error) return NextResponse.json({ error: 'Could not load Xero items.' }, { status: 500 })
  const { data: jobs } = await sb.from('jobs').select('id, address').eq('builder_id', builderId).not('status', 'eq', 'archived')
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter(token => token.length > 2)
  const scored = (description: string) => {
    const words = new Set(normalise(description)); let best: { id: string; score: number; address: string } | null = null
    for (const job of jobs ?? []) { const score = normalise(job.address).filter(word => words.has(word)).length; if (score > (best?.score ?? 0)) best = { id: job.id, score, address: job.address } }
    return best && best.score > 0 ? { suggested_job_id: best.id, suggestion_reason: `Matches ${best.address}.`, suggestion_confidence: Math.min(0.95, 0.55 + best.score * 0.12) } : { suggested_job_id: null, suggestion_reason: null, suggestion_confidence: null }
  }
  return NextResponse.json({ items: (data ?? []).map(item => ({ ...item, ...scored(item.description) })) })
}

export async function PATCH(request: NextRequest) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (process.env.XERO_ENABLED !== 'true') return NextResponse.json({ disabled: true, message: 'Xero is not enabled for this release.' }, { status: 503 })
  const body = await request.json().catch(() => ({})) as { id?: string; job_id?: string | null; trade_category_id?: number | null; status?: 'mapped' | 'ignored' }
  if (!body.id || !body.status || !['mapped', 'ignored'].includes(body.status)) return NextResponse.json({ error: 'A valid item and decision are required.' }, { status: 400 })
  if (isDemoMode()) return NextResponse.json({ updated: true })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'Xero is not configured.' }, { status: 503 })
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { error } = await sb.from('xero_import_items').update({ job_id: body.status === 'mapped' ? body.job_id : null, trade_category_id: body.status === 'mapped' ? body.trade_category_id ?? null : null, status: body.status }).eq('id', body.id).eq('builder_id', builderId)
  if (error) return NextResponse.json({ error: 'Could not save this decision.' }, { status: 500 })
  return NextResponse.json({ updated: true })
}

export async function POST(request: NextRequest) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (process.env.XERO_ENABLED !== 'true') return NextResponse.json({ disabled: true, message: 'Xero is not enabled for this release.' }, { status: 503 })
  const body = await request.json().catch(() => ({})) as { id?: string }
  if (!body.id) return NextResponse.json({ error: 'A mapped item is required.' }, { status: 400 })
  if (isDemoMode()) return NextResponse.json({ imported: true })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ error: 'Xero is not configured.' }, { status: 503 })
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const { data: item } = await sb.from('xero_import_items').select('id, external_id, item_type, description, amount, amount_paid, external_status, item_date, job_id, trade_category_id, status').eq('id', body.id).eq('builder_id', builderId).eq('status', 'mapped').maybeSingle()
  if (!item?.job_id) return NextResponse.json({ error: 'Map this item to a job before importing it.' }, { status: 400 })
  if (item.item_type === 'invoice' || item.item_type === 'bill') {
    const { error } = item.item_type === 'invoice'
      ? await sb.from('invoices').insert({ job_id: item.job_id, builder_id: builderId, amount: item.amount ?? 0, status: item.external_status === 'PAID' || (item.amount_paid ?? 0) >= (item.amount ?? 0) ? 'paid' : item.external_status === 'AUTHORISED' ? 'sent' : 'draft', invoice_number: item.external_id, due_date: item.item_date ?? undefined, created_at: item.item_date ?? undefined })
      : await sb.from('job_cost_entries').insert({ job_id: item.job_id, builder_id: builderId, trade_category_id: item.trade_category_id ?? null, description: item.description, amount: item.amount ?? 0, incurred_on: item.item_date ?? undefined, cost_kind: 'incurred' })
    if (error) return NextResponse.json({ error: 'Could not import this item into the job.' }, { status: 500 })
  }
  await sb.from('xero_import_items').update({ status: 'imported' }).eq('id', item.id).eq('builder_id', builderId)
  return NextResponse.json({ imported: true })
}
