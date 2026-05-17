/**
 * create-job — Layer 2 Decision (Backend)
 *
 * Creates a new job record with a duplicate address check. If an identical
 * or very similar address already exists for this builder, it returns a
 * duplicate warning event instead of creating a new record.
 *
 * Input:  POST { builder_id, address, client_name? }
 *
 * Output (no duplicate):
 *   { job: Job, event: { type: 'open_upload_panel', job_id } }
 *
 * Output (duplicate found):
 *   { duplicate: true, existing_job: Job, event: { type: 'show_duplicate_warning', job_id } }
 *
 * The `event` field is the Layer 3 event instruction for the UI layer.
 */

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── Types ────────────────────────────────────────────────────

interface CreateJobRequest {
  builder_id: string
  address: string
  client_name?: string
}

interface Job {
  id: string
  builder_id: string
  client_id: string | null
  address: string
  status: string
  job_type: string | null
  notes: string | null
  created_at: string
  updated_at: string
}

interface UIEvent {
  type: 'open_upload_panel' | 'show_duplicate_warning'
  job_id: string
}

interface CreateJobResponse {
  job: Job
  event: UIEvent
  duplicate?: false
}

interface CreateJobDuplicateResponse {
  duplicate: true
  existing_job: Job
  event: UIEvent
}

type CreateJobResult = CreateJobResponse | CreateJobDuplicateResponse

// ─── CORS headers ─────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function corsResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// ─── Normalise address for comparison ────────────────────────
// Strips trailing suburb/state/postcode noise and lowercases so that
// "52 Bendigo St" and "52 Bendigo Street, Footscray VIC 3011" both match.
function normaliseAddress(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/\bstreet\b/g, 'st')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\bcrescent\b/g, 'cres')
    .replace(/[,\s]+$/, '')
    .trim()
}

// ─── Handler ──────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405)
  }

  let body: CreateJobRequest
  try {
    body = await req.json() as CreateJobRequest
  } catch {
    return corsResponse(JSON.stringify({ error: 'Invalid JSON body' }), 400)
  }

  const { builder_id, address, client_name } = body

  if (!builder_id || typeof builder_id !== 'string') {
    return corsResponse(JSON.stringify({ error: 'builder_id is required' }), 400)
  }
  if (!address || typeof address !== 'string' || address.trim().length === 0) {
    return corsResponse(JSON.stringify({ error: 'address is required' }), 400)
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  if (!supabaseUrl || !supabaseServiceKey) {
    return corsResponse(JSON.stringify({ error: 'Supabase environment variables not configured' }), 500)
  }

  const supabase = createClient(supabaseUrl, supabaseServiceKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  })

  const cleanAddress = address.trim()

  try {
    // ── Verify builder exists ─────────────────────────────────
    const { data: builder, error: builderError } = await supabase
      .from('builders')
      .select('id')
      .eq('id', builder_id)
      .single()

    if (builderError || !builder) {
      return corsResponse(JSON.stringify({ error: 'Builder not found' }), 404)
    }

    // ── Duplicate address check ───────────────────────────────
    // Use ILIKE with a leading wildcard to catch partial matches.
    // We extract the street number + street name (first two tokens) as a
    // search needle so "52 Bendigo St" matches "52 Bendigo Street, Footscray".
    const addressTokens = cleanAddress.split(/[\s,]+/).slice(0, 3).join(' ')

    const { data: existingJobs } = await supabase
      .from('jobs')
      .select('id, builder_id, client_id, address, status, job_type, notes, created_at, updated_at')
      .eq('builder_id', builder_id)
      .ilike('address', `%${addressTokens}%`)
      .not('status', 'eq', 'archived')
      .limit(1)

    if (existingJobs && existingJobs.length > 0) {
      const existingJob = existingJobs[0] as Job
      // Additional normalised comparison to reduce false positives
      if (normaliseAddress(existingJob.address).includes(normaliseAddress(addressTokens))) {
        const result: CreateJobDuplicateResponse = {
          duplicate: true,
          existing_job: existingJob,
          event: {
            type: 'show_duplicate_warning',
            job_id: existingJob.id,
          },
        }
        return corsResponse(JSON.stringify(result), 200)
      }
    }

    // ── Optionally create client record ───────────────────────
    let clientId: string | null = null
    if (client_name && typeof client_name === 'string' && client_name.trim().length > 0) {
      const { data: newClient, error: clientError } = await supabase
        .from('clients')
        .insert({
          builder_id,
          name: client_name.trim(),
        })
        .select('id')
        .single()

      if (!clientError && newClient) {
        clientId = newClient.id as string
      }
    }

    // ── Create the job ────────────────────────────────────────
    const { data: newJob, error: jobError } = await supabase
      .from('jobs')
      .insert({
        builder_id,
        address: cleanAddress,
        client_id: clientId,
        status: 'quoting',
      })
      .select()
      .single()

    if (jobError || !newJob) {
      console.error('Job insert error:', jobError)
      return corsResponse(
        JSON.stringify({ error: 'Failed to create job', detail: jobError?.message }),
        500
      )
    }

    const result: CreateJobResult = {
      job: newJob as Job,
      event: {
        type: 'open_upload_panel',
        job_id: newJob.id as string,
      },
    }

    return corsResponse(JSON.stringify(result), 201)
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('create-job error:', msg)
    return corsResponse(JSON.stringify({ error: 'Failed to create job', detail: msg }), 500)
  }
})
