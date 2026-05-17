// Role hierarchy for WorkA workers
export type PermissionRole = 'owner' | 'site_manager' | 'subcontractor' | 'tradesperson'

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
