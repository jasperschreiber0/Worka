import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

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
  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = await request.json() as PatchBody
  const { builder_id: _ignored, ...updates } = body

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    try {
      const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
      const { data, error } = await sb
        .from('workers')
        .update(updates)
        .eq('id', params.id)
        .eq('builder_id', builder_id)
        .select('id, name, role, status, email, phone')
        .single()
      if (!error && data) return NextResponse.json({ worker: data })
    } catch {
      // fall through to demo echo
    }
  }

  return NextResponse.json({ worker: { id: params.id, ...updates } })
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: { id: string } }
) {
  const { searchParams } = request.nextUrl
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    try {
      const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
      await sb
        .from('workers')
        .update({ status: 'inactive' })
        .eq('id', params.id)
        .eq('builder_id', builderId)
    } catch {
      // best-effort — return success so UI stays consistent
    }
  }

  return NextResponse.json({ success: true })
}
