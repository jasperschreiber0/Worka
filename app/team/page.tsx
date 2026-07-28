import AppShell from '@/components/shell/AppShell'
import TeamView from '@/components/team/TeamView'

export const metadata = {
  title: 'WorkA — Team',
}

export default function TeamPage() {
  return (
    <AppShell>
      <TeamView />
    </AppShell>
  )
}
