import AppShell from '@/components/shell/AppShell'
import VariationsListView from '@/components/variations/VariationsListView'

export const metadata = {
  title: 'WorkA — Variations',
}

export default function VariationsPage() {
  return (
    <AppShell>
      <VariationsListView />
    </AppShell>
  )
}
