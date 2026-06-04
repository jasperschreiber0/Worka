import { getSessionUser } from '@/lib/auth/get-session'
import JobOSShell from '@/components/jobs/JobOSShell'

export const metadata = {
  title: 'Job — WorkA',
}

export default async function JobPage({ params }: { params: { id: string } }) {
  const user = await getSessionUser()
  return (
    <JobOSShell
      jobId={params.id}
      builderId={user.id}
      userName={user.full_name}
      userInitials={user.initials}
      isDemo={user.is_demo}
    />
  )
}
