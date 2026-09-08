import AppShell from '@/components/shell/AppShell'
import BuilderHome from '@/components/dashboard/BuilderHome'

export const metadata = { title: 'Worka — Today' }
export default function TodayPage() {
  return <AppShell><BuilderHome /></AppShell>
}
