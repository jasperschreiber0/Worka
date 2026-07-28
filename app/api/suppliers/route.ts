import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import type { Supplier } from '@/lib/types/database.types'

// Suppliers is a genuinely new entity (migration 081) — no chat intent ever
// created these, so there is no equivalent "shared helper" to reuse the way
// lib/workers.ts's createWorker() is shared with the chat add_worker intent.

const DEMO_SUPPLIERS: Supplier[] = [
  {
    id: 'sup-reece-001',
    builder_id: '00000000-0000-0000-0000-000000000001',
    name: 'Reece Plumbing',
    preferred_trade_category_id: null,
    contact_name: 'Dave',
    contact_phone: '0400 000 000',
    contact_email: null,
    pricing_agreement_notes: 'Trade account — 15% off list',
    created_at: new Date().toISOString(),
  },
]

export async function GET(request: NextRequest) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    try {
      const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
      const { data, error } = await sb
        .from('suppliers')
        .select('id, name, preferred_trade_category_id, contact_name, contact_phone, contact_email, pricing_agreement_notes, created_at')
        .eq('builder_id', builderId)
        .order('created_at', { ascending: false })
        .limit(100)
      if (error) {
        console.error('[/api/suppliers] query failed:', error.message)
        return NextResponse.json({ error: 'Failed to load suppliers' }, { status: 500 })
      }
      return NextResponse.json({ suppliers: data ?? [] })
    } catch (err) {
      console.error('[/api/suppliers] error:', err)
      return NextResponse.json({ error: 'Failed to load suppliers' }, { status: 500 })
    }
  }

  return NextResponse.json({ suppliers: DEMO_SUPPLIERS })
}

export async function POST(request: NextRequest) {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    name?: string
    preferred_trade_category_id?: number | null
    contact_name?: string
    contact_phone?: string
    contact_email?: string
    pricing_agreement_notes?: string
  }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const name = body.name?.trim()
  if (!name) {
    return NextResponse.json({ error: 'Supplier name is required' }, { status: 400 })
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!sbUrl || !sbKey) {
    return NextResponse.json({
      supplier: {
        id: `demo-${Date.now()}`,
        builder_id: builderId,
        name,
        preferred_trade_category_id: body.preferred_trade_category_id ?? null,
        contact_name: body.contact_name?.trim() ?? null,
        contact_phone: body.contact_phone?.trim() ?? null,
        contact_email: body.contact_email?.trim() ?? null,
        pricing_agreement_notes: body.pricing_agreement_notes?.trim() ?? null,
        created_at: new Date().toISOString(),
      } satisfies Supplier,
    }, { status: 201 })
  }

  try {
    const sb = createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data, error } = await sb
      .from('suppliers')
      .insert({
        builder_id: builderId,
        name,
        preferred_trade_category_id: body.preferred_trade_category_id ?? null,
        contact_name: body.contact_name?.trim() ?? null,
        contact_phone: body.contact_phone?.trim() ?? null,
        contact_email: body.contact_email?.trim() ?? null,
        pricing_agreement_notes: body.pricing_agreement_notes?.trim() ?? null,
      })
      .select()
      .single()

    if (error || !data) {
      console.error('[/api/suppliers] insert failed:', error?.message)
      return NextResponse.json({ error: 'Failed to add supplier' }, { status: 500 })
    }
    return NextResponse.json({ supplier: data }, { status: 201 })
  } catch (err) {
    console.error('[/api/suppliers] error:', err)
    return NextResponse.json({ error: 'Failed to add supplier' }, { status: 500 })
  }
}
