#!/usr/bin/env node
// ============================================================
// WorkA — generic external trigger for an app/api/cron/* route
// ============================================================
// Every route under app/api/cron/ (morning-brief, network-rates,
// intake-recovery) is just an authenticated GET endpoint that checks
// `Authorization: Bearer $CRON_SECRET` — none of them have any opinion
// about what actually calls them on a schedule. vercel.json used to be
// that scheduler (Vercel Cron), but this app is hosted on Railway, not
// Vercel (see CLAUDE.md's "Hosting" note) — Railway never reads
// vercel.json, so those cron entries were silently inert. This script is
// the generic HTTP call any external scheduler can drive instead: a
// Railway Cron Job service, a GitHub Actions schedule (see
// .github/workflows/*-cron.yml, which each set ROUTE_PATH and call this
// same script), a plain crontab entry — anything that can run `node` on
// a timer.
//
// Usage:
//   APP_URL=https://worka-production.up.railway.app \
//   ROUTE_PATH=/api/cron/intake-recovery \
//   CRON_SECRET=... \
//   node scripts/trigger-cron-route.mjs
//
// Exit code 0 on a successful (2xx) response, 1 otherwise — so a scheduler
// that alerts on non-zero exit (Railway, GitHub Actions, cron + a mailer)
// gets a real failure signal without parsing output.
// ============================================================

const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
const ROUTE_PATH = process.env.ROUTE_PATH
const CRON_SECRET = process.env.CRON_SECRET
const TIMEOUT_MS = Number(process.env.TRIGGER_TIMEOUT_MS) || 30_000

function log(event, fields = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...fields }))
}

async function main() {
  if (!APP_URL) {
    log('trigger_config_error', { message: 'APP_URL (or NEXT_PUBLIC_APP_URL) must be set — the app\'s real, currently-live URL (check Railway → Networking, not an assumed domain)' })
    process.exit(1)
  }
  if (!ROUTE_PATH || !ROUTE_PATH.startsWith('/api/cron/')) {
    log('trigger_config_error', { message: 'ROUTE_PATH must be set to a /api/cron/* path, e.g. /api/cron/intake-recovery' })
    process.exit(1)
  }
  if (!CRON_SECRET) {
    log('trigger_config_error', { message: 'CRON_SECRET must be set — must match the value configured on the actual running app (Railway → Variables, not just Vercel — see CLAUDE.md)' })
    process.exit(1)
  }

  const url = `${APP_URL.replace(/\/$/, '')}${ROUTE_PATH}`
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
      log('trigger_cron_route_failed', { route: ROUTE_PATH, status: res.status, body })
      process.exit(1)
    }

    log('trigger_cron_route_complete', { route: ROUTE_PATH, status: res.status, ...body })
    process.exit(0)
  } catch (err) {
    clearTimeout(timer)
    log('trigger_cron_route_error', { route: ROUTE_PATH, message: err instanceof Error ? err.message : String(err) })
    process.exit(1)
  }
}

main()
