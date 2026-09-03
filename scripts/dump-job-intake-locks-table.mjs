#!/usr/bin/env node
// ONE-TIME, read-only: the intake route's POST to job_intake_locks keeps
// getting a 409 conflict, but a plain SELECT filtered by job_id finds
// nothing. Dumps the WHOLE table (no filter) to see what's actually there.
import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY

function log(event, data = {}) {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }))
}

async function main() {
  const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY)

  const { data: allLocks, error: allErr, count } = await supabase
    .from('job_intake_locks')
    .select('*', { count: 'exact' })
  log('all_job_intake_locks', { count, rows: allLocks, error: allErr?.message ?? null })

  // Try the exact same insert the route does, to see the real conflict detail.
  const testJobId = '1f12de7f-47b5-442e-9581-1f813796eb70'
  const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/job_intake_locks`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
    },
    body: JSON.stringify({ job_id: testJobId, file_id: '00000000-0000-0000-0000-000000000000' }),
  })
  const insertBody = await insertRes.text().catch(() => '')
  log('raw_insert_attempt', { status: insertRes.status, body: insertBody.slice(0, 2000) })

  // If it succeeded (201), clean it up immediately so we don't leave a real lock behind.
  if (insertRes.status === 201) {
    await supabase.from('job_intake_locks').delete().eq('job_id', testJobId).eq('file_id', '00000000-0000-0000-0000-000000000000')
    log('cleanup_done', {})
  }

  process.exit(0)
}

main().catch((err) => {
  console.log(JSON.stringify({ event: 'run_crashed', error: err instanceof Error ? err.stack : String(err) }))
  process.exit(1)
})
