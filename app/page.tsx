import WorkspaceHome from '@/components/studio/WorkspaceHome'
import {redirect} from 'next/navigation'

export default function Home({searchParams}: {searchParams: Record<string, string | string[] | undefined>}) {
  // Existing confirmation emails return to the configured site root.
  if (searchParams.code !== undefined || searchParams.error !== undefined) {
    const params = new URLSearchParams()
    for (const key of ['code', 'error', 'next']) {
      const value = searchParams[key]
      if (typeof value === 'string') params.set(key, value)
    }
    redirect('/auth/callback?' + params.toString())
  }
  return <WorkspaceHome />
}
export const metadata = { title: 'Worka — Estimate, 3D Plan & Financials', description: 'Measure, price and explore your project. Agree the scope and track the financial outcome.' }
