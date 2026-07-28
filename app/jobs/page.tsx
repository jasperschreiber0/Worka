import { Suspense } from 'react'
import AppShell from '@/components/shell/AppShell'
import JobsListView from '@/components/jobs/JobsListView'

export const metadata = {
  title: 'WorkA — Jobs',
}

export default function JobsPage() {
  return (
    <AppShell>
      <Suspense fallback={null}>
        <JobsListView />
      </Suspense>
    </AppShell>
  )
}
