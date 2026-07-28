import { Suspense } from 'react'
import AppShell from '@/components/shell/AppShell'
import JobWorkspaceView from '@/components/jobs/JobWorkspaceView'
import { getSessionUser } from '@/lib/auth/get-session'

export const metadata = {
  title: 'WorkA — Job',
}

export default async function JobWorkspacePage({ params }: { params: { jobId: string } }) {
  const user = await getSessionUser()
  return (
    <AppShell>
      <Suspense fallback={null}>
        <JobWorkspaceView jobId={params.jobId} builderId={user.id} />
      </Suspense>
    </AppShell>
  )
}
