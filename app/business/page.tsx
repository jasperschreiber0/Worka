import AppShell from '@/components/shell/AppShell'
import BuilderHome from '@/components/dashboard/BuilderHome'

export const metadata = { title: 'Worka — Business' }
export default function BusinessPage() {
  return <AppShell><BuilderHome business /></AppShell>
}
