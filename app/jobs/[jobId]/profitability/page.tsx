import AppShell from '@/components/shell/AppShell'
import JobIntelligence from '@/components/profitability/JobIntelligence'
export const metadata = { title: 'WorkA — Job profitability review' }
export default function Page({ params }: { params: { jobId: string } }) {
  return (
    <AppShell>
      <JobIntelligence jobId={params.jobId} />
    </AppShell>
  )
}
