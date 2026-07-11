import type { Metadata, Viewport } from 'next'
import { cookies } from 'next/headers'
import { WORKER_SESSION_COOKIE } from '@/lib/auth/worker-session'
import { resolveWorkerPortalData } from '@/lib/worker-portal-data'
import WorkerPortal from './WorkerPortal'

export const metadata: Metadata = {
  title: 'WorkA — My Jobs',
  description: 'Your site details and tasks for today.',
}

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
}

export default async function WorkerPage() {
  const cookieStore = await cookies()
  const sessionCookie = cookieStore.get(WORKER_SESSION_COOKIE)?.value
  const worker = await resolveWorkerPortalData(sessionCookie)

  if (!worker) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
        <p className="text-xl font-bold text-slate-900 mb-2">No active session</p>
        <p className="text-sm text-slate-500 max-w-xs">
          Use the invite link your builder sent you to join your crew and see your jobs here.
        </p>
      </div>
    )
  }

  return <WorkerPortal worker={worker} />
}
