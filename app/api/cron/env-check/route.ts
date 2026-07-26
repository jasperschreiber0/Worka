import { NextRequest, NextResponse } from 'next/server'
import { createHash } from 'crypto'

// ─── GET /api/cron/env-check ──────────────────────────────────────────────
// TEMPORARY diagnostic route — not part of the pipeline, added solely to
// answer one question with direct evidence rather than inference: is the
// Supabase project this deployed app is actually configured against the
// SAME one migrations/pg_cron/SUPABASE_DB_URL target?
//
// Exposes nothing secret: NEXT_PUBLIC_SUPABASE_URL is already public (it
// ships in the browser bundle), and SUPABASE_SERVICE_ROLE_KEY is reported
// only as a length + truncated SHA-256 prefix, never the key itself — that
// hash prefix is compared against an out-of-band hash of the real key to
// confirm/deny a match without ever transmitting the key.
//
// Auth matches every other /api/cron/* route (Bearer CRON_SECRET, fails
// closed if unset in real mode). Delete this route once the environment-
// alignment question is answered.

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isRealMode = Boolean(supabaseUrl && supabaseKey)

  const cronSecret = process.env.CRON_SECRET
  if (isRealMode && !cronSecret) {
    return NextResponse.json({ error: 'CRON_SECRET is not configured' }, { status: 503 })
  }
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const projectRefMatch = supabaseUrl?.match(/^https:\/\/([a-z0-9]+)\.supabase\.co/)

  return NextResponse.json({
    supabase_url: supabaseUrl ?? null,
    supabase_project_ref: projectRefMatch?.[1] ?? null,
    service_role_key_present: Boolean(supabaseKey),
    service_role_key_length: supabaseKey?.length ?? null,
    service_role_key_sha256_prefix: supabaseKey
      ? createHash('sha256').update(supabaseKey).digest('hex').slice(0, 16)
      : null,
    commit_sha: process.env.RAILWAY_GIT_COMMIT_SHA ?? process.env.VERCEL_GIT_COMMIT_SHA ?? null,
    app_version: process.env.NEXT_PUBLIC_APP_VERSION ?? null,
  })
}
