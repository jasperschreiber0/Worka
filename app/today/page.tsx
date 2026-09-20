import AppShell from '@/components/shell/AppShell'
import TodayControl from '@/components/dashboard/TodayControl'

export const metadata = { title: 'Worka — Today' }
export default function TodayPage() {
  return <AppShell><TodayControl /></AppShell>
}
