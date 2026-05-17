/**
 * Supabase browser client
 * Use this in Client Components ('use client') and browser-side code.
 * Creates a singleton to avoid multiple GoTrue instances.
 */
import { createBrowserClient } from '@supabase/auth-helpers-nextjs'
import type { Database } from '@/lib/types/database.types'

let _client: ReturnType<typeof createBrowserClient<Database>> | null = null

export function createClient() {
  if (_client) return _client

  _client = createBrowserClient<Database>(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!
  )

  return _client
}
