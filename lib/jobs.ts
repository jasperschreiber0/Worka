import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import type { Job } from '@/lib/types/database.types'

// Shared by both the chat `new_job` intent (app/api/chat/route.ts) and the
// dedicated New Job panel's direct create path (app/api/jobs/route.ts POST) —
// one implementation, two callers, same duplicate-address detection either
// way (see CLAUDE.md's "New job flow" note on migration 022's guard).

export interface CreateJobParams {
  builder_id: string
  address: string
  client_name?: string
  budget_hint?: string
  scope_notes?: string
  force_create?: boolean
}

export interface CreateJobResult {
  job: Job
  is_duplicate: boolean
  existing_job?: Job
}

const SEED_JOBS: Array<{
  id: string
  address: string
  status: string
  tokens: string[]
  job_ref: string
  client_name: string
}> = [
  {
    id: '00000000-0000-0000-0000-000000000010',
    address: '14 Merri St, Fitzroy VIC 3065',
    status: 'active',
    tokens: ['14 merri st', '14 merri street'],
    job_ref: 'JOB-2025-001',
    client_name: 'Hendersons',
  },
  {
    id: '00000000-0000-0000-0000-000000000020',
    address: '8 Burnside Rd, Toorak VIC 3142',
    status: 'quoted',
    tokens: ['8 burnside'],
    job_ref: 'JOB-2025-002',
    client_name: 'Tom Caruso',
  },
  {
    id: '00000000-0000-0000-0000-000000000030',
    address: '52 Bendigo St, Brunswick VIC 3056',
    status: 'quoting',
    tokens: ['52 bendigo'],
    job_ref: 'JOB-2025-003',
    client_name: 'Brunswick client',
  },
]

function normAddress(addr: string): string {
  return addr
    .toLowerCase()
    .replace(/[.,]/g, '')
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bplace\b/g, 'pl')
    .trim()
}

function findSeedDuplicate(address: string): (typeof SEED_JOBS)[number] | null {
  const norm = normAddress(address)
  for (const job of SEED_JOBS) {
    for (const token of job.tokens) {
      if (norm.includes(token)) return job
    }
  }
  return null
}

function parseBudget(hint: string | undefined): number | null {
  if (!hint) return null
  const cleaned = hint.replace(/[,$\s]/g, '')
  const n = parseFloat(cleaned)
  return isNaN(n) ? null : n
}

export async function createJob(params: CreateJobParams): Promise<CreateJobResult> {
  const { builder_id, address, client_name, budget_hint, scope_notes, force_create } = params
  const budgetValue = parseBudget(budget_hint)

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (supabaseUrl && serviceRoleKey) {
    try {
      const supabase = createClient(supabaseUrl, serviceRoleKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })

      // Ensure builder row exists — handles users who signed up before the trigger was applied
      await supabase.from('builders').upsert(
        { id: builder_id, email: '', name: builder_id },
        { onConflict: 'id', ignoreDuplicates: true }
      )

      if (!force_create) {
        const firstTokens = address.trim().split(/\s+/).slice(0, 3).join(' ')
        const { data: existing } = await supabase
          .from('jobs')
          .select('*')
          .eq('builder_id', builder_id)
          .neq('status', 'archived')
          .ilike('address', `%${firstTokens}%`)
          .limit(1)
          .maybeSingle()

        if (existing) {
          return {
            job: existing as Job,
            is_duplicate: true,
            existing_job: existing as Job,
          }
        }
      }

      let clientId: string | null = null
      if (client_name && client_name.trim().length > 0) {
        const { data: newClient } = await supabase
          .from('clients')
          .insert({ builder_id, name: client_name.trim() })
          .select('id')
          .single()
        if (newClient) clientId = newClient.id as string
      }

      const { data: jobRow, error } = await supabase
        .from('jobs')
        .insert({
          builder_id,
          address: address.trim(),
          status: 'quoting' as const,
          client_id: clientId,
          job_type: null,
          notes: client_name ? `Client: ${client_name}` : null,
          budget_estimate: budgetValue,
          scope_notes: scope_notes ?? null,
        })
        .select()
        .single()

      if (!error && jobRow) {
        return { job: jobRow as Job, is_duplicate: false }
      }

      // Unique-violation (23505) means a concurrent request won the race for
      // this exact address — re-fetch and return it as the duplicate instead
      // of surfacing an insert error.
      if (error?.code === '23505') {
        const { data: winner } = await supabase
          .from('jobs')
          .select('*')
          .eq('builder_id', builder_id)
          .neq('status', 'archived')
          .ilike('address', address.trim())
          .limit(1)
          .maybeSingle()
        if (winner) {
          return { job: winner as Job, is_duplicate: true, existing_job: winner as Job }
        }
      }

      // A real insert failure must surface as a real error — the caller
      // already shows "Couldn't save the job right now" on a thrown error.
      // Silently falling through to a fabricated demo job here would tell
      // the builder a job was created when nothing was actually written.
      throw new Error(error?.message ?? 'Job insert failed')
    } catch (err) {
      // Supabase was configured, so this is a genuine failure, not a
      // "demo mode" situation — rethrow instead of masking it.
      console.error('[createJob] Supabase error:', err)
      throw err
    }
  }

  // Demo mode (only reached when Supabase isn't configured at all)
  if (!force_create) {
    const duplicate = findSeedDuplicate(address)
    if (duplicate) {
      const existingJob: Job = {
        id: duplicate.id,
        builder_id,
        client_id: null,
        address: duplicate.address,
        status: duplicate.status as Job['status'],
        job_type: null,
        notes: null,
        budget_estimate: null,
        scope_notes: null,
        quote_deadline: null,
        client_deadline: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      }
      return { job: existingJob, is_duplicate: true, existing_job: existingJob }
    }
  }

  const fakeId = randomUUID()
  const newJob: Job = {
    id: fakeId,
    builder_id,
    client_id: null,
    address: address.trim(),
    status: 'quoting',
    job_type: null,
    notes: client_name ? `Client: ${client_name}` : null,
    budget_estimate: budgetValue,
    scope_notes: scope_notes ?? null,
    quote_deadline: null,
    client_deadline: null,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  }

  return { job: newJob, is_duplicate: false }
}
