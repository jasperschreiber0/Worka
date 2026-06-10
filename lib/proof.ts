// ─── WorkA Proof engine ───────────────────────────────────────────────────────
// Central, tamper-evident audit trail. Every consequential action on a job
// (quote sent, variation approved, invoice sent, email sent, job activated)
// is recorded here automatically — zero extra builder effort.
//
// Each event is hash-chained: proof_hash = sha256 over the event content plus
// the previous event's hash. Any retrospective edit breaks the chain, which is
// what makes the trail defensible in a payment dispute.
//
// Works in both modes:
//   - Demo: appends to an in-memory per-job log
//   - Real: inserts into the proof_events table (service role — server only)
//
// Recording is best-effort by design: a proof write must never break the
// builder action it documents. Failures are logged and return null.

import { createHash, randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import { demoActivationState, formatDisplayTime, type DemoProofEvent } from '@/lib/activation-demo'

// ─── Types ────────────────────────────────────────────────────────────────────

export type ProofEvent = DemoProofEvent

export interface RecordProofEventInput {
  jobId: string
  builderId: string
  eventType: string
  description: string
  metadata?: Record<string, unknown>
}

export interface ProofChainStatus {
  /** True when every hash-chained event re-verifies against its predecessor. */
  verified: boolean
  /** Number of events carrying a valid hash chain link. */
  chained_count: number
  total_count: number
}

const GENESIS_HASH = 'genesis'

// ─── In-memory demo proof log (per job) ───────────────────────────────────────
// Kept on globalThis so every route bundle shares one log — Next.js can give
// each route its own module instance, which would silently fork the trail.

const globalForProof = globalThis as unknown as { __workaDemoProofLog?: Map<string, ProofEvent[]> }

export const demoProofLog: Map<string, ProofEvent[]> =
  globalForProof.__workaDemoProofLog ?? (globalForProof.__workaDemoProofLog = new Map())

// ─── Demo seed events ─────────────────────────────────────────────────────────
// Historical comms-derived events for the demo jobs, so the trail isn't empty
// on first open. Not hash-chained — they predate the proof engine.

const DEMO_SEED_EVENTS: Record<string, Array<Pick<ProofEvent, 'event_type' | 'description'> & { days_ago: number }>> = {
  '00000000-0000-0000-0000-000000000011': [
    { event_type: 'quote_sent', description: 'Quote for $127,500 sent to Tom Caruso', days_ago: 5 },
  ],
  '00000000-0000-0000-0000-000000000020': [
    { event_type: 'quote_sent', description: 'Quote for $127,500 sent to Tom Caruso', days_ago: 5 },
  ],
  '00000000-0000-0000-0000-000000000010': [
    { event_type: 'invoice_sent', description: 'Invoice for $28,000 sent to the Hendersons', days_ago: 7 },
    { event_type: 'variation_pending', description: 'Variation requested: Upgrade kitchen benchtop to 40mm Caesarstone ($3,200)', days_ago: 2 },
  ],
}

function demoSeedEvents(jobId: string): ProofEvent[] {
  const seeds = DEMO_SEED_EVENTS[jobId] ?? []
  return seeds.map((seed, index) => {
    const createdAt = new Date(Date.now() - seed.days_ago * 24 * 60 * 60 * 1000).toISOString()
    return {
      id: `seed-${jobId}-${index}`,
      job_id: jobId,
      event_type: seed.event_type,
      description: seed.description,
      metadata: null,
      created_at: createdAt,
      display_time: formatDisplayTime(createdAt),
    }
  })
}

// ─── Hash chain ───────────────────────────────────────────────────────────────

function isRealMode(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  return Boolean(url && url !== 'your-supabase-url' && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/** Metadata stripped of chain fields — the hash covers content, not itself. */
function baseMetadata(metadata: Record<string, unknown> | null): Record<string, unknown> {
  if (!metadata) return {}
  const { proof_hash: _h, prev_hash: _p, ...rest } = metadata
  return rest
}

function computeProofHash(
  prevHash: string,
  event: Pick<ProofEvent, 'job_id' | 'event_type' | 'description' | 'created_at'>,
  metadata: Record<string, unknown>
): string {
  return createHash('sha256')
    .update(
      [prevHash, event.job_id, event.event_type, event.description, event.created_at, JSON.stringify(metadata)].join('\n')
    )
    .digest('hex')
}

function chainHashOf(event: ProofEvent): string | null {
  const hash = event.metadata?.proof_hash
  return typeof hash === 'string' ? hash : null
}

/**
 * Re-verify the hash chain across a job's events (oldest first).
 * Events without a proof_hash (seed/legacy data) are counted but not chained.
 */
export function verifyProofChain(events: ProofEvent[]): ProofChainStatus {
  const ascending = [...events].sort(
    (a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
  )

  let prevHash = GENESIS_HASH
  let chainedCount = 0
  let verified = true

  for (const event of ascending) {
    const storedHash = chainHashOf(event)
    if (!storedHash) continue

    const storedPrev = typeof event.metadata?.prev_hash === 'string' ? event.metadata.prev_hash : GENESIS_HASH
    const recomputed = computeProofHash(storedPrev, event, baseMetadata(event.metadata))
    if (recomputed !== storedHash || storedPrev !== prevHash) {
      verified = false
    }
    prevHash = storedHash
    chainedCount += 1
  }

  return { verified, chained_count: chainedCount, total_count: events.length }
}

// ─── Read ─────────────────────────────────────────────────────────────────────

/**
 * All proof events for a job, most recent first.
 * Demo: merges activation events, seed history, and the live proof log.
 * Real: reads the proof_events table.
 */
export async function getJobProofEvents(jobId: string): Promise<ProofEvent[]> {
  if (isRealMode()) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    const { data, error } = await supabase
      .from('proof_events')
      .select('id, job_id, event_type, description, metadata, created_at')
      .eq('job_id', jobId)
      .order('created_at', { ascending: false })

    if (error) {
      console.error('[proof] Failed to read proof_events:', error)
      return []
    }

    return ((data ?? []) as Array<Omit<ProofEvent, 'display_time'>>).map((row) => ({
      ...row,
      display_time: formatDisplayTime(row.created_at),
    }))
  }

  // Demo: merge sources, dedup by id (activation events are also in the log)
  const activationEvents = demoActivationState.get(jobId)?.proof_events ?? []
  const merged = new Map<string, ProofEvent>()
  for (const event of [...demoSeedEvents(jobId), ...activationEvents, ...(demoProofLog.get(jobId) ?? [])]) {
    merged.set(event.id, event)
  }

  return Array.from(merged.values()).sort(
    (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
  )
}

// ─── Write ────────────────────────────────────────────────────────────────────

/**
 * Record a proof event, chained to the previous event for the job.
 * Never throws — returns null on failure so the calling action proceeds.
 */
export async function recordProofEvent(input: RecordProofEventInput): Promise<ProofEvent | null> {
  const createdAt = new Date().toISOString()
  const content = {
    job_id: input.jobId,
    event_type: input.eventType,
    description: input.description,
    created_at: createdAt,
  }
  const metadata = input.metadata ?? {}

  try {
    if (isRealMode()) {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } }
      )

      const { data: lastRows } = await supabase
        .from('proof_events')
        .select('metadata')
        .eq('job_id', input.jobId)
        .order('created_at', { ascending: false })
        .limit(1)

      const lastMetadata = (lastRows?.[0] as { metadata: Record<string, unknown> | null } | undefined)?.metadata
      const prevHash = typeof lastMetadata?.proof_hash === 'string' ? lastMetadata.proof_hash : GENESIS_HASH
      const proofHash = computeProofHash(prevHash, content, metadata)
      const fullMetadata = { ...metadata, proof_hash: proofHash, prev_hash: prevHash }

      const event: ProofEvent = {
        id: randomUUID(),
        ...content,
        metadata: fullMetadata,
        display_time: 'just now',
      }

      const { error } = await supabase.from('proof_events').insert({
        id: event.id,
        job_id: input.jobId,
        builder_id: input.builderId,
        event_type: input.eventType,
        description: input.description,
        metadata: fullMetadata,
        created_at: createdAt,
      })
      if (error) {
        console.error('[proof] Failed to insert proof event:', error)
        return null
      }
      return event
    }

    // Demo mode: chain off the in-memory log
    const log = demoProofLog.get(input.jobId) ?? []
    const lastChained = [...log].reverse().find((e) => chainHashOf(e) !== null)
    const prevHash = lastChained ? chainHashOf(lastChained)! : GENESIS_HASH
    const proofHash = computeProofHash(prevHash, content, metadata)

    const event: ProofEvent = {
      id: randomUUID(),
      ...content,
      metadata: { ...metadata, proof_hash: proofHash, prev_hash: prevHash },
      display_time: 'just now',
    }

    log.push(event)
    demoProofLog.set(input.jobId, log)
    return event
  } catch (err) {
    console.error('[proof] recordProofEvent error:', err)
    return null
  }
}
