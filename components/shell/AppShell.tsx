'use client'

import NavRail, { MobileTabBar } from './NavRail'
import CommandPalette from './CommandPalette'

interface AppShellProps {
  children?: React.ReactNode
  /** When true, children manage their own height/scroll (e.g. the chat page's
   * own internal split layout) — AppShell just supplies the rail, no extra
   * padding or scroll container around children. */
  bare?: boolean
}

// The shared layout every workflow route (Jobs, Team, Suppliers, Variations,
// Chat) mounts itself inside. Deliberately a plain wrapper component, not a
// Next.js route-group layout — /chat already exists as a real top-level
// route directory, and each page choosing to wrap itself keeps this a
// zero-risk addition rather than a routing restructure.
export default function AppShell({ children, bare = false }: AppShellProps) {
  return (
    <div className="h-screen flex flex-col md:flex-row overflow-hidden" style={{ background: 'var(--bg-shell)' }}>
      <NavRail />
      <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
        {bare ? children : (
          <div className="flex-1 overflow-y-auto">{children}</div>
        )}
      </div>
      <MobileTabBar />
      <CommandPalette />
    </div>
  )
}
