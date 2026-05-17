import ChatInterface from '@/components/chat/ChatInterface'

export const metadata = {
  title: 'WorkA — Morning Brief',
  description: 'AI operations manager for Australian builders',
}

export default function ChatPage() {
  return (
    <main className="h-screen flex flex-col overflow-hidden bg-white">
      <ChatInterface />
    </main>
  )
}
