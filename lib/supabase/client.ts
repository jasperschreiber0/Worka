/**
 * Supabase browser client
 * Use this in Client Components ('use client') and browser-side code.
 * Creates a singleton to avoid multiple GoTrue instances.
 */
import { createClient as createSupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/types/database.types'

let _client: ReturnType<typeof createSupabaseClient<Database>> | null = null

export function createClient() {
  if (_client) return _client

  _client = createSupabaseClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  return _client
}
