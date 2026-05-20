import type { Metadata } from 'next'
import { getDemoInvite } from '@/lib/worker-demo'
import JoinFlow from './JoinFlow'

interface JoinPageProps {
  params: Promise<{ token: string }>
}

export const metadata: Metadata = {
  title: 'Join WorkA',
  description: "You've been invited to join a WorkA crew.",
}

export default async function JoinPage({ params }: JoinPageProps) {
  const { token } = await params

  // In live mode: look up the invite token in the workers table.
  // In demo mode: return a pre-seeded invite so the flow works without Supabase.
  const invite = getDemoInvite(token)

  if (!invite) {
    return (
      <div className="min-h-screen bg-white flex flex-col items-center justify-center px-6 text-center">
        <p className="text-xl font-bold text-slate-900 mb-2">Invalid invite link</p>
        <p className="text-sm text-slate-500">
          This invite link is invalid or has expired. Ask your builder to send a new one.
        </p>
      </div>
    )
  }

  return <JoinFlow invite={invite} />
}
