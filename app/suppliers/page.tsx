import AppShell from '@/components/shell/AppShell'
import SuppliersView from '@/components/suppliers/SuppliersView'

export const metadata = {
  title: 'WorkA — Suppliers',
}

export default function SuppliersPage() {
  return (
    <AppShell>
      <SuppliersView />
    </AppShell>
  )
}
