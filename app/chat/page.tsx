import { Suspense } from 'react'
import ChatShell from './ChatShell'

export const metadata = {
  title: 'WorkA — Morning Brief',
  description: 'AI operations manager for Australian builders',
}

// ChatShell uses useSearchParams() which requires a Suspense boundary
// at build time to avoid a static generation error.
export default function ChatPage() {
  return (
    <main className="h-screen overflow-hidden">
      <Suspense fallback={<div className="h-screen bg-white" />}>
        <ChatShell />
      </Suspense>
    </main>
  )
}
