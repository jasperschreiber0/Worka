import { getSessionUser } from '@/lib/auth/get-session'
import JobList from '@/components/jobs/JobList'

export const metadata = {
  title: 'Jobs — WorkA',
}

export default async function JobsPage() {
  const user = await getSessionUser()
  return (
    <JobList
      builderId={user.id}
      userName={user.full_name}
      userInitials={user.initials}
      isDemo={user.is_demo}
    />
  )
}
