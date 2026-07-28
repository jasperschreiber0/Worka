import { createClient } from '@supabase/supabase-js'
import { randomUUID } from 'crypto'
import type { Worker } from '@/lib/types/database.types'

// Shared by both the chat `add_worker` intent (app/api/chat/route.ts) and the
// dedicated Team panel's direct create path (app/api/workers/route.ts POST) —
// one implementation, two callers, so a worker created via a form and one
// created by typing "add worker Jack, carpenter" in chat are indistinguishable
// afterward (same invite-token generation, same demo-mode fallback).

export interface CreateWorkerParams {
  builder_id: string
  name: string
  role: string
  email?: string
  phone?: string
  hourly_rate?: number
  default_markup_pct?: number
  available?: boolean
}

export interface WorkerModalEvent {
  type: 'open_worker_modal'
  worker_id: string
}

export interface CreateWorkerResult {
  worker: Worker
  invite_url: string
  modal_event: WorkerModalEvent
}

export async function createWorker(params: CreateWorkerParams): Promise<CreateWorkerResult> {
  const { builder_id, name, role, email, phone, hourly_rate, default_markup_pct, available } = params

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (supabaseUrl && serviceRoleKey) {
    const supabase = createClient(supabaseUrl, serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    })

    await supabase.from('builders').upsert(
      { id: builder_id, email: '', name: builder_id },
      { onConflict: 'id', ignoreDuplicates: true }
    )

    const { data: workerRow, error } = await supabase
      .from('workers')
      .insert({
        builder_id,
        name: name.trim(),
        role: role.trim().toLowerCase(),
        email: email?.trim() ?? null,
        phone: phone?.trim() ?? null,
        status: 'invited' as const,
        ...(hourly_rate !== undefined ? { hourly_rate } : {}),
        ...(default_markup_pct !== undefined ? { default_markup_pct } : {}),
        ...(available !== undefined ? { available } : {}),
      })
      .select()
      .single()

    if (error || !workerRow) {
      throw new Error(error?.message ?? 'Failed to insert worker')
    }

    const appUrl = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'
    const invite_url = `${appUrl}/join/${workerRow.invite_token ?? 'unknown'}`

    return {
      worker: workerRow as Worker,
      invite_url,
      modal_event: { type: 'open_worker_modal', worker_id: workerRow.id },
    }
  }

  const fakeId = randomUUID()
  const fakeToken = 'demo-invite-token'
  const worker: Worker = {
    id: fakeId,
    builder_id,
    name: name.trim(),
    role: role.trim().toLowerCase(),
    email: email?.trim() ?? null,
    phone: phone?.trim() ?? null,
    status: 'invited',
    invite_token: fakeToken,
    created_at: new Date().toISOString(),
  }

  return {
    worker,
    invite_url: `http://localhost:3000/join/${fakeToken}`,
    modal_event: { type: 'open_worker_modal', worker_id: fakeId },
  }
}
