import { cookies } from 'next/headers'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import type { Database } from '@/lib/types/database.types'

export const DEMO_BUILDER_ID = '00000000-0000-0000-0000-000000000001'

export function isDemoMode(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  return !url || url === 'your-supabase-url'
}

/**
 * Resolve the builder identity for an API route from the Supabase auth
 * session (cookie-based). Returns the demo builder in demo mode.
 *
 * Returns null when no authenticated session exists — routes must respond
 * 401 and must never fall back to a client-supplied builder_id.
 */
export async function getAuthenticatedBuilderId(): Promise<string | null> {
  if (isDemoMode()) return DEMO_BUILDER_ID

  try {
    const supabase = createRouteHandlerClient<Database>({ cookies })
    const { data: { user } } = await supabase.auth.getUser()
    return user?.id ?? null
  } catch {
    return null
  }
}
