import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { isDemoMode } from '@/lib/auth/api-auth'

// ─── GET /api/health ────────────────────────────────────────────────────────
// Launch-plan Section C item 4: "no way to confirm what's actually deployed
// without checking Railway's dashboard directly" — the exact gap that turned
// the Round 12 stale-build incident into ~2 hours of re-running an E2E
// against a build that had never actually shipped (see CLAUDE.md's TypeScript
// Compatibility Rules / build-failure lesson). Public, unauthenticated (its
// whole purpose is answering "what's live" without needing credentials) and
// never cached, so it always reflects the running process, not a prerender.
//
// Deliberately narrow: version/commit identity plus a best-effort DB
// reachability signal. NOT a general health-monitoring/alerting system —
// that's tracked separately (Launch Plan Section C item 1, still deferred)
// and already has real infrastructure (intake_recovery_runs, the
// supabase/verification/health_monitoring_views.sql views). No secrets, no
// builder data, ever.

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  const demoMode = isDemoMode()

  let database: 'ok' | 'unreachable' | 'not_configured' = 'not_configured'
  if (!demoMode) {
    const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (supabaseUrl && serviceRoleKey) {
      try {
        const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } })
        // trade_categories is the cheapest possible reachability probe: a
        // fixed, tiny (13-row), immutable platform table (see CLAUDE.md —
        // "The 13 trade categories are immutable") that every builder's
        // queries already depend on being reachable.
        const { error } = await supabase.from('trade_categories').select('id', { count: 'exact', head: true })
        database = error ? 'unreachable' : 'ok'
      } catch {
        database = 'unreachable'
      }
    }
  }

  return NextResponse.json({
    status: 'ok',
    version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
    commit_sha: process.env.NEXT_PUBLIC_COMMIT_SHA ?? null,
    mode: demoMode ? 'demo' : 'live',
    database,
    timestamp: new Date().toISOString(),
  })
}
