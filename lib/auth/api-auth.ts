import { cookies, headers } from 'next/headers'
import { createRouteHandlerClient } from '@supabase/auth-helpers-nextjs'
import type { Database } from '@/lib/types/database.types'

export const DEMO_BUILDER_ID = '00000000-0000-0000-0000-000000000001'

export function isDemoMode(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  return !url || url === 'your-supabase-url'
}

/**
 * Resolve the builder identity for an API route.
 *
 * Accepts auth in two forms:
 *   1. Cookie session (browser requests via the app)
 *   2. Authorization: Bearer <SUPABASE_SERVICE_ROLE_KEY> (internal server-to-server calls,
 *      e.g. the intake worker route calling scope-hints)
 *
 * Returns null when no authenticated session exists — routes must respond 401.
 */
export async function getAuthenticatedBuilderId(): Promise<string | null> {
  if (isDemoMode()) return DEMO_BUILDER_ID

  // Allow internal server-to-server calls that present the service-role key
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (serviceRoleKey) {
    try {
      const authHeader = headers().get('authorization') ?? ''
      if (authHeader === `Bearer ${serviceRoleKey}`) {
        return DEMO_BUILDER_ID
      }
    } catch {
      // headers() can throw outside a request context — ignore
    }
  }

  try {
    const supabase = createRouteHandlerClient<Database>({ cookies })
    const { data: { user } } = await supabase.auth.getUser()
    return user?.id ?? null
  } catch {
    return null
  }
}
