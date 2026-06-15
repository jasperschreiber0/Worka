import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── Types ────────────────────────────────────────────────────────────────────

interface DisconnectResponse {
  disconnected: boolean
}

// ─── POST handler ─────────────────────────────────────────────────────────────

export async function POST(
  request: NextRequest
): Promise<NextResponse<DisconnectResponse | { error: string }>> {
  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {

    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

    if (supabaseUrl && serviceRoleKey) {
      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })

      // Mark sync state as inactive — all logs are retained
      await supabase
        .from('email_sync_state')
        .update({ is_active: false })
        .eq('builder_id', builder_id)

      // Update builders table
      await supabase
        .from('builders')
        .update({ email_sync_enabled: false })
        .eq('id', builder_id)

      return NextResponse.json({ disconnected: true })
    }

    // Demo mode: return mock response (no Supabase configured)
    return NextResponse.json({ disconnected: true })
  } catch (err) {
    console.error('[/api/email-sync/disconnect] Error:', err)
    return NextResponse.json({ error: 'Failed to disconnect email sync' }, { status: 500 })
  }
}
