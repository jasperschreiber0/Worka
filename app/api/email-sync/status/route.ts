import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─── Types ────────────────────────────────────────────────────────────────────

interface EmailSyncStatusResponse {
  connected: boolean
  provider: 'gmail' | 'outlook' | null
  connected_at: string | null
  last_synced_at: string | null
  is_active: boolean
  emails_processed_today: number
  jobs_matched_today: number
}

interface EmailSyncStateRow {
  provider: 'gmail' | 'outlook'
  connected_at: string
  last_synced_at: string | null
  is_active: boolean
}

// ─── Relative date helper ─────────────────────────────────────────────────────

function relativeDate(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffMins = Math.floor(diffMs / (1000 * 60))
  const diffHours = Math.floor(diffMs / (1000 * 60 * 60))
  const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24))

  if (diffMins < 2) return 'just now'
  if (diffMins < 60) return `${diffMins} minutes ago`
  if (diffHours < 2) return '1 hour ago'
  if (diffHours < 24) return `${diffHours} hours ago`
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  const diffWeeks = Math.floor(diffDays / 7)
  if (diffWeeks < 5) return `${diffWeeks} week${diffWeeks !== 1 ? 's' : ''} ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`
}

// ─── GET handler ──────────────────────────────────────────────────────────────

export async function GET(
  request: NextRequest
): Promise<NextResponse<EmailSyncStatusResponse>> {
  const { searchParams } = new URL(request.url)
  const builder_id = searchParams.get('builder_id')

  if (!builder_id) {
    return NextResponse.json({
      connected: false,
      provider: null,
      connected_at: null,
      last_synced_at: null,
      is_active: false,
      emails_processed_today: 0,
      jobs_matched_today: 0,
    })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (supabaseUrl && serviceRoleKey) {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    const { data } = await supabase
      .from('email_sync_state')
      .select('provider, connected_at, last_synced_at, is_active')
      .eq('builder_id', builder_id)
      .maybeSingle()

    if (data) {
      const row = data as EmailSyncStateRow

      // Count emails processed today from communication_history
      const todayStart = new Date()
      todayStart.setHours(0, 0, 0, 0)

      const { count: emailsToday } = await supabase
        .from('communication_history')
        .select('id', { count: 'exact', head: true })
        .eq('builder_id', builder_id)
        .eq('direction', 'inbound')
        .eq('channel', 'email')
        .gte('timestamp', todayStart.toISOString())

      const { count: matchedToday } = await supabase
        .from('communication_history')
        .select('id', { count: 'exact', head: true })
        .eq('builder_id', builder_id)
        .eq('direction', 'inbound')
        .eq('channel', 'email')
        .not('job_id', 'is', null)
        .gte('timestamp', todayStart.toISOString())

      return NextResponse.json({
        connected: row.is_active,
        provider: row.provider,
        connected_at: relativeDate(row.connected_at),
        last_synced_at: row.last_synced_at ? relativeDate(row.last_synced_at) : null,
        is_active: row.is_active,
        emails_processed_today: emailsToday ?? 0,
        jobs_matched_today: matchedToday ?? 0,
      })
    }
  }

  // Demo mode or no record found: disconnected
  return NextResponse.json({
    connected: false,
    provider: null,
    connected_at: null,
    last_synced_at: null,
    is_active: false,
    emails_processed_today: 0,
    jobs_matched_today: 0,
  })
}
