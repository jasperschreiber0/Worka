#!/usr/bin/env node
// ============================================================
// Verifies GET /api/health against the real deployed app.
// Launch Plan Section C item 4 — confirms deployment identity can be
// checked without going to Railway's dashboard directly.
// ============================================================

const APP_URL = process.env.APP_URL || process.env.NEXT_PUBLIC_APP_URL
const EXPECTED_COMMIT_SHA = process.env.EXPECTED_COMMIT_SHA || null

if (!APP_URL) {
  console.error(JSON.stringify({ event: 'config_error', message: 'APP_URL must be set' }))
  process.exit(1)
}

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

async function main() {
  let passed = true
  const failures = []

  const res = await fetch(`${APP_URL.replace(/\/$/, '')}/api/health`)
  const body = await res.json().catch(() => ({}))
  log('health_response', { status: res.status, body })

  if (res.ok) log('check_passed', { name: 'http_200' })
  else { passed = false; failures.push(`expected 200, got ${res.status}`) }

  if (body.status === 'ok') log('check_passed', { name: 'status_ok' })
  else { passed = false; failures.push(`expected status:'ok', got ${body.status}`) }

  if (typeof body.commit_sha === 'string' && body.commit_sha.length > 0) {
    log('check_passed', { name: 'commit_sha_present', commit_sha: body.commit_sha })
  } else {
    passed = false
    failures.push('commit_sha missing or empty')
  }

  if (EXPECTED_COMMIT_SHA) {
    if (body.commit_sha === EXPECTED_COMMIT_SHA.slice(0, 7)) {
      log('check_passed', { name: 'commit_sha_matches_expected', expected: EXPECTED_COMMIT_SHA.slice(0, 7), actual: body.commit_sha })
    } else {
      passed = false
      failures.push(`commit_sha mismatch: expected ${EXPECTED_COMMIT_SHA.slice(0, 7)}, got ${body.commit_sha}`)
    }
  }

  if (body.mode === 'live' || body.mode === 'demo') log('check_passed', { name: 'mode_present', mode: body.mode })
  else { passed = false; failures.push(`unexpected mode: ${body.mode}`) }

  if (['ok', 'unreachable', 'not_configured'].includes(body.database)) {
    log('check_passed', { name: 'database_field_present', database: body.database })
  } else {
    passed = false
    failures.push(`unexpected database field: ${body.database}`)
  }

  // No secrets/internal fields should ever appear.
  const serialized = JSON.stringify(body)
  const forbidden = ['SUPABASE_SERVICE_ROLE_KEY', 'ANTHROPIC_API_KEY', 'RESEND_API_KEY', 'CRON_SECRET']
  const leaked = forbidden.filter((f) => serialized.includes(f))
  if (leaked.length === 0) log('check_passed', { name: 'no_secrets_leaked' })
  else { passed = false; failures.push(`secret key names leaked: ${leaked.join(', ')}`) }

  log(passed ? 'run_passed' : 'run_FAILED', { passed, failures })
  process.exit(passed ? 0 : 1)
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
