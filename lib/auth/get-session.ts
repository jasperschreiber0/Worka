import { cookies } from 'next/headers'
import { createServerComponentClient } from '@supabase/auth-helpers-nextjs'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/lib/types/database.types'

export interface SessionUser {
  id: string
  email: string
  full_name: string
  initials: string
  is_demo: boolean
}

const DEMO_USER: SessionUser = {
  id: '00000000-0000-0000-0000-000000000001',
  email: 'demo@worka.com.au',
  full_name: 'Dave Nguyen',
  initials: 'DN',
  is_demo: true,
}

function toInitials(name: string): string {
  return name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('')
}

export async function getSessionUser(): Promise<SessionUser> {
  // Demo mode: no Supabase connected
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return DEMO_USER
  }

  try {
    const supabase = createServerComponentClient<Database>({ cookies })
    const { data: { session } } = await supabase.auth.getSession()

    if (!session?.user) return DEMO_USER

    const meta = session.user.user_metadata as { full_name?: string; company_name?: string }
    const fullName = meta.full_name ?? session.user.email?.split('@')[0] ?? 'Builder'

    // Ensure builders row exists — migration 008 trigger only fires for new signups,
    // so backfill silently for any user who signed up before 008 was applied.
    const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY
    if (serviceKey && process.env.NEXT_PUBLIC_SUPABASE_URL) {
      const admin = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL, serviceKey, {
        auth: { autoRefreshToken: false, persistSession: false },
      })
      await admin.from('builders').upsert(
        { id: session.user.id, email: session.user.email ?? '', name: fullName, business_name: meta.company_name ?? null },
        { onConflict: 'id', ignoreDuplicates: true }
      )
    }

    return {
      id: session.user.id,
      email: session.user.email ?? '',
      full_name: fullName,
      initials: toInitials(fullName),
      is_demo: false,
    }
  } catch {
    return DEMO_USER
  }
}
