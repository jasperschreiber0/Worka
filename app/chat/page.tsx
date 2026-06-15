import { Suspense } from 'react'
import ChatShell from './ChatShell'
import { getSessionUser } from '@/lib/auth/get-session'

export const metadata = {
  title: 'WorkA — Morning Brief',
  description: 'AI operations manager for Australian builders',
}

// ChatShell uses useSearchParams() which requires a Suspense boundary
// at build time to avoid a static generation error.
export default async function ChatPage() {
  const user = await getSessionUser()

  return (
    <main className="h-screen overflow-hidden">
      <Suspense fallback={<div className="h-screen" style={{ backgroundColor: 'var(--bg-shell)' }} />}>
        <ChatShell builderId={user.id} userName={user.full_name} userInitials={user.initials} isDemo={user.is_demo} />
      </Suspense>
    </main>
  )
}
