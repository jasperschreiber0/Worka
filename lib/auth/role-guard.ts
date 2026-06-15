export type PermissionRole = 'owner' | 'site_manager' | 'subcontractor' | 'tradesperson'

const VALID_ROLES: PermissionRole[] = ['owner', 'site_manager', 'subcontractor', 'tradesperson']

export function getRoleFromRequest(req: Request): PermissionRole {
  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL

  if (isDemoMode) {
    // Demo: trust the x-worka-role header for testing worker flows
    const header = req.headers.get('x-worka-role')
    if (header && (VALID_ROLES as string[]).includes(header)) {
      return header as PermissionRole
    }
    return 'owner'
  }

  // Live mode: extract role from Supabase JWT claims.
  // Workers get a role claim set when their invite token is redeemed.
  // Builders authenticated via Supabase auth have no role claim → owner.
  const auth = req.headers.get('authorization') ?? ''
  if (auth.startsWith('Bearer ')) {
    try {
      const token = auth.slice(7)
      const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString())
      const role = payload?.app_metadata?.worka_role as string | undefined
      if (role && (VALID_ROLES as string[]).includes(role)) {
        return role as PermissionRole
      }
    } catch {
      // Malformed token — fall through to default
    }
  }

  // Authenticated builders have no worker role claim → treat as owner
  return 'owner'
}

export function requirePermission(
  req: Request,
  action: keyof typeof ROLE_REQUIREMENTS
): Response | null {
  const role = getRoleFromRequest(req)
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
