'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

interface NotificationItem {
  id: string
  job_id: string | null
  type: string
  title: string
  body: string | null
  entity_type: string | null
  entity_id: string | null
  read: boolean
  created_at: string
}

function timeAgo(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diffMs / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins}m ago`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

// Polls rather than pushing — this feed is a convenience view over actions
// that already happen through explicit builder flows (variation raised,
// quote sent, etc), so a short poll interval is enough freshness without a
// realtime subscription.
const POLL_MS = 30_000

export default function NotificationsBell() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [notifications, setNotifications] = useState<NotificationItem[]>([])
  const [unreadCount, setUnreadCount] = useState(0)
  const containerRef = useRef<HTMLDivElement>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/notifications')
      if (!res.ok) return
      const data = await res.json()
      setNotifications(data.notifications ?? [])
      setUnreadCount(data.unread_count ?? 0)
    } catch { /* silent — a stale badge is not worth surfacing an error for */ }
  }, [])

  useEffect(() => {
    load()
    const interval = setInterval(load, POLL_MS)
    return () => clearInterval(interval)
  }, [load])

  useEffect(() => {
    if (!open) return
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', handleClick)
    return () => document.removeEventListener('mousedown', handleClick)
  }, [open])

  async function handleOpen() {
    const next = !open
    setOpen(next)
    if (next && unreadCount > 0) {
      const unreadIds = notifications.filter((n) => !n.read).map((n) => n.id)
      setNotifications((prev) => prev.map((n) => ({ ...n, read: true })))
      setUnreadCount(0)
      if (unreadIds.length > 0) {
        fetch('/api/notifications/mark-read', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids: unreadIds }),
        }).catch(() => {})
      }
    }
  }

  function handleClickNotification(n: NotificationItem) {
    setOpen(false)
    if (n.job_id) router.push(`/jobs/${n.job_id}`)
  }

  return (
    <div ref={containerRef} className="relative">
      <button
        type="button"
        onClick={handleOpen}
        className="relative flex items-center justify-center w-9 h-9 rounded-[6px] transition-colors"
        style={{ color: 'var(--text-secondary)' }}
        aria-label="Notifications"
      >
        <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={1.75} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M14.857 17.082a23.848 23.848 0 005.454-1.31A8.967 8.967 0 0118 9.75V9A6 6 0 006 9v.75a8.967 8.967 0 01-2.312 6.022c1.733.64 3.56 1.085 5.455 1.31m5.714 0a24.255 24.255 0 01-5.714 0m5.714 0a3 3 0 11-5.714 0" />
        </svg>
        {unreadCount > 0 && (
          <span
            className="absolute top-1 right-1 min-w-[16px] h-4 px-1 rounded-full flex items-center justify-center text-[10px] font-semibold"
            style={{ background: 'var(--status-red)', color: '#fff' }}
          >
            {unreadCount > 9 ? '9+' : unreadCount}
          </span>
        )}
      </button>

      {open && (
        <div
          className="absolute left-0 top-full mt-2 w-80 max-h-[400px] overflow-y-auto rounded-[8px] z-50"
          style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)', boxShadow: '0 8px 24px rgba(0,0,0,0.15)' }}
        >
          <div className="px-4 py-3" style={{ borderBottom: '0.5px solid var(--bg-border)' }}>
            <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>Notifications</span>
          </div>
          {notifications.length === 0 ? (
            <div className="px-4 py-8 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
              Nothing yet — job activity will show up here.
            </div>
          ) : (
            notifications.map((n) => (
              <button
                key={n.id}
                type="button"
                onClick={() => handleClickNotification(n)}
                className="w-full text-left px-4 py-3 flex flex-col gap-0.5 hover:brightness-110 transition-all"
                style={{ borderBottom: '0.5px solid var(--bg-border)' }}
              >
                <span className="text-sm" style={{ color: 'var(--text-primary)', fontWeight: n.read ? 400 : 600 }}>{n.title}</span>
                {n.body && (
                  <span className="text-xs truncate" style={{ color: 'var(--text-secondary)' }}>{n.body}</span>
                )}
                <span className="text-[11px]" style={{ color: 'var(--text-tertiary)' }}>{timeAgo(n.created_at)}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  )
}
