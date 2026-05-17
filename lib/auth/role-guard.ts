// Role hierarchy for WorkA workers
export type PermissionRole = 'owner' | 'site_manager' | 'subcontractor' | 'tradesperson'

/**
 * Extract the caller's role from a Next.js API request.
 * In demo mode the header x-worka-role is trusted for testing.
 * In production this would be read from the Supabase JWT claims.
 */
export function getRoleFromRequest(req: Request): PermissionRole {
  const header = req.headers.get('x-worka-role')
  const valid: PermissionRole[] = ['owner', 'site_manager', 'subcontractor', 'tradesperson']
  if (header && (valid as string[]).includes(header)) {
    return header as PermissionRole
  }
  // Default: treat unauthenticated requests as owner in demo mode.
  // In production, throw a 401 if no valid JWT role claim is present.
  return 'owner'
}

/**
 * Returns a 403 Response if the caller's role lacks the required permission.
 * Call at the top of any route handler that mutates data.
 */
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

// Actions and their minimum required roles
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
