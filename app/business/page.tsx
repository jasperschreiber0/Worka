import AppShell from '@/components/shell/AppShell'
import BusinessControl from '@/components/profitability/BusinessControl'

export const metadata = { title: 'Worka — Business' }
export default function BusinessPage() {
  return <AppShell><BusinessControl /></AppShell>
}
