import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { buildBriefEmail, getDemoBrief, type BriefAlert } from '@/lib/morning-brief'

// ─── GET /api/cron/morning-brief ─────────────────────────────────────────────
// Scheduled daily by Vercel Cron (see vercel.json) — delivers the morning
// brief to every builder by email at 6:45am AEST. This is the daily habit:
// the builder opens their phone and WorkA has already done the thinking.
//
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` automatically
// when the CRON_SECRET env var is set on the project.
//
// Demo mode (no Supabase): sends the demo brief to MORNING_BRIEF_TEST_EMAIL
// if set, so the loop can be tested end-to-end without production data.

export const dynamic = 'force-dynamic'

interface BuilderRow {
  id: string
  name: string
  email: string
}

interface EdgeBriefResponse {
  brief: string
  alerts: BriefAlert[]
}

async function sendBriefEmail(resendApiKey: string, to: string, subject: string, text: string): Promise<boolean> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from: 'WorkA <noreply@worka.app>',
      to: [to],
      subject,
      text,
    }),
  })
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { message?: string }
    console.error(`[cron/morning-brief] Resend error for ${to}:`, err.message ?? res.status)
    return false
  }
  return true
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── Auth guard ─────────────────────────────────────────────────────────────
  // Fail closed: when Supabase is configured (real builders, real emails) the
  // endpoint requires a matching CRON_SECRET — a missing secret means no run.
  const cronSecret = process.env.CRON_SECRET
  const isRealMode = Boolean(process.env.NEXT_PUBLIC_SUPABASE_URL)
  if (isRealMode && !cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const resendApiKey = process.env.RESEND_API_KEY
  if (!resendApiKey) {
    return NextResponse.json({ sent: 0, skipped: 'RESEND_API_KEY not configured — brief not delivered' })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isDemoMode = !supabaseUrl || supabaseUrl === 'your-supabase-url' || !serviceRoleKey

  // ── Demo mode: single test delivery ────────────────────────────────────────
  if (isDemoMode) {
    const testEmail = process.env.MORNING_BRIEF_TEST_EMAIL
    if (!testEmail) {
      return NextResponse.json({
        sent: 0,
        skipped: 'Demo mode — set MORNING_BRIEF_TEST_EMAIL to test brief delivery',
      })
    }
    const demo = getDemoBrief()
    const email = buildBriefEmail(demo.builderName, demo.brief, demo.alerts)
    const ok = await sendBriefEmail(resendApiKey, testEmail, email.subject, email.text)
    return NextResponse.json({ sent: ok ? 1 : 0, failed: ok ? 0 : 1, demo: true })
  }

  // ── Real mode: one brief per builder ───────────────────────────────────────
  const supabase = createClient(supabaseUrl, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const { data: builders, error } = await supabase.from('builders').select('id, name, email')
  if (error) {
    console.error('[cron/morning-brief] Failed to list builders:', error)
    return NextResponse.json({ error: 'Failed to list builders' }, { status: 500 })
  }

  let sent = 0
  let failed = 0

  for (const builder of (builders ?? []) as BuilderRow[]) {
    if (!builder.email) continue
    try {
      // Layer 2 Decision: the morning-brief edge function builds the ranked brief
      const briefRes = await fetch(`${supabaseUrl}/functions/v1/morning-brief`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${serviceRoleKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ builder_id: builder.id }),
      })
      if (!briefRes.ok) {
        console.error(`[cron/morning-brief] morning-brief function failed for ${builder.id}: ${briefRes.status}`)
        failed += 1
        continue
      }

      const { brief, alerts } = (await briefRes.json()) as EdgeBriefResponse
      const email = buildBriefEmail(builder.name, brief, alerts ?? [])
      const ok = await sendBriefEmail(resendApiKey, builder.email, email.subject, email.text)
      if (ok) sent += 1
      else failed += 1
    } catch (err) {
      console.error(`[cron/morning-brief] Error for builder ${builder.id}:`, err)
      failed += 1
    }
  }

  return NextResponse.json({ sent, failed, builders: (builders ?? []).length })
}
