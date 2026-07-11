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

  // Explicit field allowlist — never pass the raw body straight into an
  // .update() call, or any column name the client sends (not just the
  // ones this route intends to expose) would be written.
  const updates: Partial<Pick<PatchBody, 'name' | 'role' | 'status' | 'email' | 'phone'>> = {}
  if (body.name !== undefined) updates.name = body.name
  if (body.role !== undefined) updates.role = body.role
  if (body.status !== undefined) updates.status = body.status
  if (body.email !== undefined) updates.email = body.email
  if (body.phone !== undefined) updates.phone = body.phone

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (sbUrl && sbKey) {
    // A real update failure must surface as a real error — echoing back the
    // requested change as if it succeeded would tell the builder a worker
    // record was updated when nothing was actually written.
    try {
      const sb = createClient(sbUrl, sbKey, { auth: { persistSession: false } })
      const { data, error } = await sb
        .from('workers')
        .update(updates)
        .eq('id', params.id)
        .eq('builder_id', builder_id)
        .select('id, name, role, status, email, phone')
        .single()
      if (error || !data) {
        console.error('[/api/workers/[id]] update failed:', error?.message)
        return NextResponse.json({ error: 'Failed to update worker' }, { status: 500 })
      }
      return NextResponse.json({ worker: data })
    } catch (err) {
      console.error('[/api/workers/[id]] error:', err)
      return NextResponse.json({ error: 'Failed to update worker' }, { status: 500 })
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
      const { error } = await sb
        .from('workers')
        .update({ status: 'inactive' })
        .eq('id', params.id)
        .eq('builder_id', builderId)
      if (error) {
        console.error('[/api/workers/[id]] deactivate failed:', error.message)
        return NextResponse.json({ error: 'Failed to remove worker' }, { status: 500 })
      }
    } catch (err) {
      console.error('[/api/workers/[id]] error:', err)
      return NextResponse.json({ error: 'Failed to remove worker' }, { status: 500 })
    }
  }

  return NextResponse.json({ success: true })
}
