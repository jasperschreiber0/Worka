// Constructs the service-role Supabase client the shared AI gateway
// (supabase/functions/smooth-responder/ai-gateway.ts) uses for spend
// accounting and the usage ledger from a Next.js route. Returns null in demo
// mode (no Supabase configured) — the gateway then falls back to its
// process-local in-memory daily counters, per its own module header.
//
// Deliberately not a general-purpose shared client (this codebase's Auth
// section documents why no shared admin-client singleton exists — a prior
// one was deleted as unused): this is scoped to exactly one consumer, the
// gateway context, and should not be imported for general queries.
import { createClient, type SupabaseClient } from '@supabase/supabase-js'

export function gatewaySupabase(): SupabaseClient | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !key || url === 'your-supabase-url') return null
  return createClient(url, key, { auth: { persistSession: false } })
}
