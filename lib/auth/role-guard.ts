import { createClient } from '@supabase/supabase-js'

export type PermissionRole = 'owner' | 'site_manager' | 'subcontractor' | 'tradesperson'

const VALID_ROLES: PermissionRole[] = ['owner', 'site_manager', 'subcontractor', 'tradesperson']

/**
 * Resolve the caller's permission role from the request.
 *
 * Live mode: the Authorization bearer token is verified against Supabase
 * Auth itself (auth.getUser(token)) — this actually checks the token's
 * signature and expiry, rather than trusting an unverified, client-suppliable
 * JWT payload. A forged bearer token with a fabricated `worka_role` claim is
 * rejected here (getUser fails), falling through to the 'owner' default,
 * exactly as if no token were presented at all.
 */
export async function getRoleFromRequest(req: Request): Promise<PermissionRole> {
  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL

  if (isDemoMode) {
    // Demo: trust the x-worka-role header for testing worker flows
    const header = req.headers.get('x-worka-role')
    if (header && (VALID_ROLES as string[]).includes(header)) {
      return header as PermissionRole
    }
    return 'owner'
  }

  // Live mode: extract role from a Supabase-verified session, not a raw
  // decoded JWT payload. Workers get a role claim set when their invite
  // token is redeemed. Builders authenticated via Supabase auth have no
  // role claim → owner.
  const auth = req.headers.get('authorization') ?? ''
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  if (auth.startsWith('Bearer ') && supabaseUrl && anonKey) {
    try {
      const token = auth.slice(7)
      const supabase = createClient(supabaseUrl, anonKey, { auth: { persistSession: false } })
      const { data, error } = await supabase.auth.getUser(token)
      if (!error && data.user) {
        const role = (data.user.app_metadata as Record<string, unknown> | undefined)?.worka_role as string | undefined
        if (role && (VALID_ROLES as string[]).includes(role)) {
          return role as PermissionRole
        }
      }
    } catch {
      // Invalid/expired token — fall through to default
    }
  }

  // Authenticated builders have no worker role claim → treat as owner
  return 'owner'
}

export async function requirePermission(
  req: Request,
  action: keyof typeof ROLE_REQUIREMENTS
): Promise<Response | null> {
  const role = await getRoleFromRequest(req)
  const minimum = ROLE_REQUIREMENTS[action]
  if (!hasPermission(role, minimum)) {
    return new Response(
      JSON.stringify({ error: `Insufficient role. '${action}' requires ${minimum} or above.` }),
      { status: 403, headers: { 'Content-Type': 'application/json' } }
    )
  }
  return null
}

const ROLE_WEIGHT: Record<PermissionRole, number> = {
  owner: 4,
  site_manager: 3,
  subcontractor: 2,
  tradesperson: 1,
}

export function hasPermission(userRole: PermissionRole, minimumRole: PermissionRole): boolean {
  return ROLE_WEIGHT[userRole] >= ROLE_WEIGHT[minimumRole]
}

export const ROLE_REQUIREMENTS = {
  approve_variation: 'site_manager',
  reject_variation: 'site_manager',
  activate_job: 'owner',
  send_quote: 'owner',
  send_email: 'owner',
  view_job: 'tradesperson',
  view_quote: 'site_manager',
  view_invoices: 'site_manager',
} as const satisfies Record<string, PermissionRole>
