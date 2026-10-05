import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { buildBriefEmail, getDemoBrief } from '@/lib/morning-brief'
import {loadBriefActions} from '@/lib/brief-source'
import {dueActions} from '@/lib/brief-actions'
import {deliverBrief} from '@/lib/brief-delivery'
import {briefDeliveryStore} from '@/lib/brief-delivery-store'

// ─── GET /api/cron/morning-brief ─────────────────────────────────────────────
// Scheduled by GitHub Actions; delivers actionable recorded job items by email.
// Auth: scheduler supplies Authorization: Bearer ${CRON_SECRET}.
//
// Demo mode (no Supabase): sends the demo brief to MORNING_BRIEF_TEST_EMAIL
// if set, so the loop can be tested end-to-end without production data.

export const dynamic = 'force-dynamic'

interface BuilderRow {
  id: string
  name: string
  email: string
}

async function sendBriefEmail(resendApiKey: string, to: string, subject: string, text: string, html: string, idempotencyKey?: string): Promise<boolean> {
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${resendApiKey}`,
      'Content-Type': 'application/json',
      ...(idempotencyKey ? {'Idempotency-Key': idempotencyKey} : {}),
    },
    body: JSON.stringify({
      from: `WorkA <${process.env.EMAIL_FROM_ADDRESS ?? 'hello@getworka.com'}>`,
      to: [to],
      subject,
      text,
      html,
    }),
    signal: AbortSignal.timeout(30000),
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
  const dryRun = request.nextUrl.searchParams.get('dryRun') === '1'
  if (!resendApiKey && !dryRun) {
    return NextResponse.json({ sent: 0, skipped: 'RESEND_API_KEY not configured — brief not delivered' })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isDemoMode = !supabaseUrl || supabaseUrl === 'your-supabase-url' || !serviceRoleKey

  // ── Demo mode: single test delivery ────────────────────────────────────────
  if (isDemoMode) {
    if(dryRun)return NextResponse.json({sent:0,dryRun:true,demo:true})
    const testEmail = process.env.MORNING_BRIEF_TEST_EMAIL
    if (!testEmail) {
      return NextResponse.json({
        sent: 0,
        skipped: 'Demo mode — set MORNING_BRIEF_TEST_EMAIL to test brief delivery',
      })
    }
    const demo = getDemoBrief()
    const email = buildBriefEmail(demo.builderName, demo.brief, demo.alerts)
    const ok = await sendBriefEmail(resendApiKey!, testEmail, email.subject, email.text, email.html)
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
  let skipped = 0
  let previewActions = 0

  for (const builder of (builders ?? []) as BuilderRow[]) {
    if (!builder.email || builder.id.startsWith('00000000-0000-0000-0000-') || /^synthetic\b/i.test(builder.name)) continue
    try {
      const now=new Date(),actions=await loadBriefActions(supabase,builder.id,now)
      if(dryRun){
        const {data,error}=await supabase.from('morning_brief_delivery').select('state').eq('builder_id',builder.id).maybeSingle()
        if(error)throw error
        previewActions+=dueActions(actions,data?.state?.sent||{},now).length
        continue
      }
      const io=briefDeliveryStore(supabase,builder.id,p=>sendBriefEmail(resendApiKey!,p.to,p.email.subject,p.email.text,p.email.html,`morning-brief/${builder.id}/${p.id}`))
      const result=await deliverBrief(io,builder,actions,now)
      if(result==='sent')sent++
      else if(result==='failed')failed++
      else skipped++
    } catch (err) {
      console.error(`[cron/morning-brief] Error for builder ${builder.id}:`, err)
      failed += 1
    }
  }

  return NextResponse.json({ sent, failed, skipped, builders: (builders ?? []).length,...(dryRun?{dryRun:true,previewActions}:{}) },{status:failed?503:200})
}
