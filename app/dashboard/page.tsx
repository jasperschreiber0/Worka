import { Suspense } from 'react'
import { getSessionUser } from '@/lib/auth/get-session'
import DashboardShell from './DashboardShell'

export default async function DashboardPage() {
  const user = await getSessionUser()

  return (
    <Suspense>
      <DashboardShell
        builderId={user.id}
        userName={user.full_name}
        userInitials={user.initials}
      />
    </Suspense>
  )
}
