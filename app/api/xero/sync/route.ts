import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { getXeroAccessToken } from '@/lib/xero-token'

export async function POST() {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (process.env.XERO_ENABLED !== 'true') return NextResponse.json({ disabled: true, message: 'Xero is not enabled for this release.' }, { status: 503 })
  if (isDemoMode()) return NextResponse.json({ synced: false, message: 'Demo mode — connect a real Xero organisation before syncing.' })
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key) return NextResponse.json({ synced: false, message: 'Xero is not configured yet.' }, { status: 503 })
  const sb = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } })
  const token = await getXeroAccessToken(builderId)
  if (!token) return NextResponse.json({ synced: false, message: 'Xero needs to be connected or reconnected before syncing.' }, { status: 400 })
  const { connection } = token
  const runId = crypto.randomUUID()
  await sb.from('xero_sync_runs').insert({ id: runId, builder_id: builderId, connection_id: connection.id, status: 'running', started_at: new Date().toISOString() })
  try {
    const accessToken = token.accessToken
    const headers = { Authorization: `Bearer ${accessToken}`, Accept: 'application/json', 'Xero-tenant-id': connection.tenant_id }
    const [invoiceResponse, contactResponse] = await Promise.all([fetch('https://api.xero.com/api.xro/2.0/Invoices?page=1', { headers }), fetch('https://api.xero.com/api.xro/2.0/Contacts?page=1', { headers })])
    if (!invoiceResponse.ok || !contactResponse.ok) throw new Error('Xero API request failed')
    const invoiceData = await invoiceResponse.json() as { Invoices?: Array<{ InvoiceID: string; Type: string; Status?: string; InvoiceNumber?: string; Contact?: { Name?: string }; Total?: number; AmountPaid?: number; DueDateString?: string; DateString?: string }> }
    const contactData = await contactResponse.json() as { Contacts?: Array<{ ContactID: string; Name?: string }> }
    const items = [
      ...((invoiceData.Invoices ?? []).filter(invoice => ['ACCPAY', 'ACCREC'].includes(invoice.Type)).map(invoice => ({ builder_id: builderId, connection_id: connection.id, external_id: invoice.InvoiceID, item_type: invoice.Type === 'ACCPAY' ? 'bill' : 'invoice', description: `${invoice.Contact?.Name ?? 'Xero contact'} · ${invoice.InvoiceNumber ?? 'Invoice'}`, amount: invoice.Total ?? null, amount_paid: invoice.AmountPaid ?? 0, external_status: invoice.Status ?? null, item_date: (invoice.DueDateString ?? invoice.DateString)?.slice(0, 10) ?? null }))),
      ...((contactData.Contacts ?? []).map(contact => ({ builder_id: builderId, connection_id: connection.id, external_id: contact.ContactID, item_type: 'contact', description: contact.Name ?? 'Xero contact', amount: null, item_date: null }))),
    ]
    if (items.length > 0) await sb.from('xero_import_items').upsert(items, { onConflict: 'connection_id,external_id', ignoreDuplicates: true })
    await sb.from('xero_connections').update({ last_synced_at: new Date().toISOString() }).eq('id', connection.id).eq('builder_id', builderId)
    await sb.from('xero_sync_runs').update({ status: 'completed', completed_at: new Date().toISOString(), imported_count: items.length, failed_count: 0 }).eq('id', runId)
    return NextResponse.json({ synced: true, count: items.length, message: `${items.length} Xero item${items.length === 1 ? '' : 's'} ready for review.` })
  } catch (error) {
    console.error('[xero/sync]', error)
    await sb.from('xero_sync_runs').update({ status: 'failed', completed_at: new Date().toISOString(), failed_count: 1, error_message: 'Xero could not be reached.' }).eq('id', runId)
    return NextResponse.json({ synced: false, message: 'Xero could not be reached. Try reconnecting, then sync again.' }, { status: 502 })
  }
}
