// ─── Builder notification feed ────────────────────────────────────────────────
// A read/unread UI feed over the same actions proof_events already records.
// createNotification() is called from exactly one place — recordProofEvent()
// (lib/proof.ts) — so every existing proof-event call site (quote sent,
// variation submitted/approved/rejected, job activated, etc) produces a
// notification automatically, with no new call sites to remember to add.
//
// Best-effort by design, same as recordProofEvent: never throws, a failure
// here must not break the builder action it's notifying about.

import { randomUUID } from 'crypto'
import { createClient } from '@supabase/supabase-js'
import type { Notification } from '@/lib/types/database.types'

export interface CreateNotificationInput {
  builderId: string
  jobId?: string | null
  type: string
  title: string
  body?: string | null
  entityType?: string | null
  entityId?: string | null
}

function isRealMode(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  return Boolean(url && url !== 'your-supabase-url' && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

// ─── In-memory demo store ──────────────────────────────────────────────────
// Kept on globalThis so every route bundle shares one feed, same pattern as
// demoProofLog in lib/proof.ts.

const globalForNotifications = globalThis as unknown as { __workaDemoNotifications?: Map<string, Notification[]> }

export const demoNotifications: Map<string, Notification[]> =
  globalForNotifications.__workaDemoNotifications ?? (globalForNotifications.__workaDemoNotifications = new Map())

export async function createNotification(input: CreateNotificationInput): Promise<Notification | null> {
  const createdAt = new Date().toISOString()
  const notification: Notification = {
    id: randomUUID(),
    builder_id: input.builderId,
    job_id: input.jobId ?? null,
    type: input.type,
    title: input.title,
    body: input.body ?? null,
    entity_type: input.entityType ?? null,
    entity_id: input.entityId ?? null,
    read: false,
    created_at: createdAt,
  }

  try {
    if (isRealMode()) {
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { autoRefreshToken: false, persistSession: false } }
      )
      const { error } = await supabase.from('notifications').insert(notification)
      if (error) {
        console.error('[notifications] Failed to insert:', error)
        return null
      }
      return notification
    }

    const list = demoNotifications.get(input.builderId) ?? []
    list.unshift(notification)
    demoNotifications.set(input.builderId, list.slice(0, 200))
    return notification
  } catch (err) {
    console.error('[notifications] createNotification error:', err)
    return null
  }
}

export async function listNotifications(builderId: string, limit = 50): Promise<{ notifications: Notification[]; unread_count: number }> {
  if (isRealMode()) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    const [{ data }, { count }] = await Promise.all([
      supabase
        .from('notifications')
        .select('*')
        .eq('builder_id', builderId)
        .order('created_at', { ascending: false })
        .limit(limit),
      supabase
        .from('notifications')
        .select('id', { count: 'exact', head: true })
        .eq('builder_id', builderId)
        .eq('read', false),
    ])
    return { notifications: (data ?? []) as Notification[], unread_count: count ?? 0 }
  }

  const list = demoNotifications.get(builderId) ?? []
  return { notifications: list.slice(0, limit), unread_count: list.filter((n) => !n.read).length }
}

export async function markNotificationsRead(builderId: string, ids: string[] | 'all'): Promise<void> {
  if (isRealMode()) {
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
      { auth: { autoRefreshToken: false, persistSession: false } }
    )
    let query = supabase.from('notifications').update({ read: true }).eq('builder_id', builderId)
    if (ids !== 'all') query = query.in('id', ids)
    await query
    return
  }

  const list = demoNotifications.get(builderId) ?? []
  for (const n of list) {
    if (ids === 'all' || ids.includes(n.id)) n.read = true
  }
  demoNotifications.set(builderId, list)
}

// ─── Proof event -> notification copy ──────────────────────────────────────
// Not every proof event type needs a notification (e.g. routine comms log
// entries), and the wording a builder wants in a short feed row differs from
// the fuller proof-trail description. This is deliberately a small allowlist,
// not a 1:1 mirror of every event_type — silence for anything not listed.

const NOTIFIABLE_EVENT_TYPES: Record<string, string> = {
  variation_submitted: 'New variation raised',
  variation_approved: 'Variation approved',
  variation_rejected: 'Variation rejected',
  quote_sent: 'Quote sent to client',
  job_activated: 'Job activated',
  invoice_sent: 'Invoice sent',
}

export function titleForProofEvent(eventType: string): string | null {
  return NOTIFIABLE_EVENT_TYPES[eventType] ?? null
}
