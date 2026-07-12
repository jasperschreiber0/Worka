/**
 * smooth-responder — Layer 2 Decision (Backend)
 *
 * Thin, no-timeout trigger for the document-intake pipeline. Accepts
 * POST { file_id, job_id, builder_id, sibling_file_ids }, returns 202
 * immediately, and hands the actual extraction work off (via
 * EdgeRuntime.waitUntil, so it isn't cut short) to
 * POST /api/intake/[fileId]/worker — the Next.js route that owns the real
 * pipeline: single tool-use Claude call across the primary doc *and* its
 * siblings, hybrid document pricing, memory retrieval, scope intelligence.
 *
 * This function used to run its own (older, single-file, no sibling
 * support) extraction pass inline. That duplicate pipeline is why
 * multi-file uploads only ever produced a quote from the first PDF —
 * this function never saw the other files at all. Do not reintroduce
 * inline extraction here; the worker route is the single source of truth.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const appUrl = Deno.env.get('APP_URL')

  if (!supabaseUrl || !supabaseKey || !appUrl) {
    return new Response(JSON.stringify({ error: 'Missing environment variables (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, APP_URL)' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  let body: { file_id: string; job_id: string; builder_id: string; sibling_file_ids?: string[] }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const { file_id, job_id, builder_id, sibling_file_ids } = body
  if (!file_id || !job_id || !builder_id) {
    return new Response(JSON.stringify({ error: 'file_id, job_id, builder_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(supabaseUrl, supabaseKey)

  const dispatch = async () => {
    try {
      const res = await fetch(`${appUrl.replace(/\/$/, '')}/api/intake/${encodeURIComponent(file_id)}/worker`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${supabaseKey}`,
        },
        body: JSON.stringify({
          builder_id,
          job_id,
          sibling_file_ids: Array.isArray(sibling_file_ids) ? sibling_file_ids : [],
        }),
      })
      if (!res.ok) {
        console.error('smooth-responder: worker route returned', res.status, await res.text().catch(() => ''))
      }
    } catch (err) {
      console.error('smooth-responder: dispatch to worker route failed:', err)
      // The worker route itself handles its own failure bookkeeping once
      // reached — this is only for the case the request never got there at
      // all, so the file doesn't sit stuck at "processing" forever.
      try {
        await supabase
          .from('files')
          .update({ intake_status: 'failed', failure_stage: 'AI_EXTRACTION_FAILED', failure_reason: 'Failed to reach intake worker' })
          .eq('id', file_id)
      } catch { /* best-effort */ }
    }
  }

  // @ts-expect-error EdgeRuntime is a Deno Deploy global, not in the TS lib
  EdgeRuntime.waitUntil(dispatch())

  return new Response(JSON.stringify({ status: 'started' }), {
    status: 202,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
