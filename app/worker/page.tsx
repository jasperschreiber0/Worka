import type { Metadata, Viewport } from 'next'
import { DEMO_WORKER_JACK } from '@/lib/worker-demo'
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

export default function WorkerPage() {
  // In live mode: read the worker session from Supabase Auth and load their jobs.
  // In demo mode: use the seeded worker data.
  return <WorkerPortal worker={DEMO_WORKER_JACK} />
}
