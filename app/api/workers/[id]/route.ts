import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

interface PatchBody {
  builder_id: string
  name?: string
  role?: string
  status?: 'active' | 'inactive'
  email?: string | null
  phone?: string | null
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const body = await request.json() as PatchBody
  const { builder_id, ...updates } = body
  if (!builder_id) return NextResponse.json({ error: 'builder_id required' }, { status: 400 })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
    const { data, error } = await sb
      .from('workers')
      .update(updates)
      .eq('id', params.id)
      .eq('builder_id', builder_id)
      .select('id, name, role, status, email, phone')
      .single()
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ worker: data })
  }

  // Demo mode: echo back
  return NextResponse.json({ worker: { id: params.id, ...updates } })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { searchParams } = request.nextUrl
  const builderId = searchParams.get('builder_id')
  if (!builderId) return NextResponse.json({ error: 'builder_id required' }, { status: 400 })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
    const { error } = await sb
      .from('workers')
      .update({ status: 'inactive' })
      .eq('id', params.id)
      .eq('builder_id', builderId)
    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
  }

  return NextResponse.json({ success: true })
}
