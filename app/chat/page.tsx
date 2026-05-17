import ChatShell from './ChatShell'

export const metadata = {
  title: 'WorkA — Morning Brief',
  description: 'AI operations manager for Australian builders',
}

export default function ChatPage() {
  return (
    <main className="h-screen overflow-hidden">
      <ChatShell />
    </main>
  )
}
