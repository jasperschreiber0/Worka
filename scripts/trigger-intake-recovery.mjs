#!/usr/bin/env node
// ============================================================
// WorkA — external trigger for GET /api/cron/intake-recovery
// ============================================================
// The recovery route itself (app/api/cron/intake-recovery/route.ts) is just
// an authenticated GET endpoint — it has no opinion about what calls it on
// a schedule. vercel.json wires it into Vercel Cron, but Vercel Cron below
// the Pro plan only fires once a day, far too coarse for this route's job
// (its own staleness windows are 3-6 minutes — see migration 037 and
// CLAUDE.md's "Independent Intake Recovery Service"). This script is the
// same HTTP call, packaged so ANY external scheduler can drive it instead:
// a Railway Cron Job service, a GitHub Actions schedule (see
// .github/workflows/intake-recovery-cron.yml, which uses this script), a
// plain crontab entry, anything that can run `node` on a timer.
//
// Usage:
//   APP_URL=https://getworka.com CRON_SECRET=... node scripts/trigger-intake-recovery.mjs
//
// Exit code 0 on a successful (2xx) response, 1 otherwise — so a scheduler
// that alerts on non-zero exit (Railway, GitHub Actions, cron + a mailer)
// gets a real failure signal without parsing output.
// ============================================================

const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
const CRON_SECRET = process.env.CRON_SECRET
const TIMEOUT_MS = Number(process.env.TRIGGER_TIMEOUT_MS) || 30_000

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  if (!APP_URL) {
    log('trigger_config_error', { message: 'APP_URL (or NEXT_PUBLIC_APP_URL) must be set — e.g. https://getworka.com' })
    process.exit(1)
  }
  if (!CRON_SECRET) {
    log('trigger_config_error', { message: 'CRON_SECRET must be set — must match the value configured on the Vercel app' })
    process.exit(1)
  }

  const url = `${APP_URL.replace(/\/$/, '')}/api/cron/intake-recovery`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)

  try {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${CRON_SECRET}` },
      signal: controller.signal,
    })
    clearTimeout(timer)
    const body = await res.json().catch(() => ({}))

    if (!res.ok) {
      log('trigger_recovery_failed', { status: res.status, body })
      process.exit(1)
    }

    log('trigger_recovery_complete', { status: res.status, ...body })
    process.exit(0)
  } catch (err) {
    clearTimeout(timer)
    log('trigger_recovery_error', { message: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  }
}

main()
