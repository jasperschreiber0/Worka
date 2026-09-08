'use client'

import Link from 'next/link'
import { usePathname } from 'next/navigation'
import NotificationsBell from './NotificationsBell'

interface NavItemDef {
  href: string
  label: string
  icon: React.ReactNode
}

const ICON_PROPS = {
  className: 'w-5 h-5 flex-shrink-0',
  fill: 'none' as const,
  viewBox: '0 0 24 24',
  stroke: 'currentColor',
  strokeWidth: 1.75,
  'aria-hidden': true as const,
}

const NAV_ITEMS: NavItemDef[] = [
  { href: '/today', label: 'Today', icon: <svg {...ICON_PROPS}><path strokeLinecap="round" strokeLinejoin="round" d="M8 3v4m8-4v4M4 10h16M5 5h14a1 1 0 011 1v14H4V6a1 1 0 011-1z" /></svg> },
  { href: '/jobs', label: 'Jobs', icon: <svg {...ICON_PROPS}><path strokeLinecap="round" strokeLinejoin="round" d="M3 10l9-7 9 7M5 9v12h14V9M9 21v-7h6v7" /></svg> },
  { href: '/business', label: 'Business', icon: <svg {...ICON_PROPS}><path strokeLinecap="round" strokeLinejoin="round" d="M4 20V10h4v10m4 0V4h4v16m4 0H2" /></svg> },
]

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(href + '/') ||
    (href === '/business' && ['/team', '/suppliers', '/variations'].some(path => pathname === path || pathname.startsWith(path + '/')))
}

const SETTINGS_ITEM: NavItemDef = {
  href: '/settings',
  label: 'Settings',
  icon: (
    <svg {...ICON_PROPS}>
      <path strokeLinecap="round" strokeLinejoin="round" d="M9.594 3.94c.09-.542.56-.94 1.11-.94h2.593c.55 0 1.02.398 1.11.94l.213 1.281c.063.374.313.686.645.87.074.04.147.083.22.127.324.196.72.257 1.075.124l1.217-.456a1.125 1.125 0 011.37.49l1.296 2.247a1.125 1.125 0 01-.26 1.431l-1.003.827c-.293.24-.438.613-.431.992a6.759 6.759 0 010 .255c-.007.378.138.75.43.99l1.005.828c.424.35.534.954.26 1.43l-1.298 2.247a1.125 1.125 0 01-1.369.491l-1.217-.456c-.355-.133-.75-.072-1.076.124a6.57 6.57 0 01-.22.128c-.331.183-.581.495-.644.869l-.213 1.28c-.09.543-.56.941-1.11.941h-2.594c-.55 0-1.019-.398-1.11-.94l-.213-1.281c-.062-.374-.312-.686-.644-.87a6.52 6.52 0 01-.22-.127c-.325-.196-.72-.257-1.076-.124l-1.217.456a1.125 1.125 0 01-1.369-.49l-1.297-2.247a1.125 1.125 0 01.26-1.431l1.004-.827c.292-.24.437-.613.43-.992a6.932 6.932 0 010-.255c.007-.378-.138-.75-.43-.99l-1.004-.828a1.125 1.125 0 01-.26-1.43l1.297-2.247a1.125 1.125 0 011.37-.491l1.216.456c.356.133.751.072 1.076-.124.072-.044.146-.087.22-.128.332-.183.582-.495.644-.869l.214-1.28z" />
      <path strokeLinecap="round" strokeLinejoin="round" d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
    </svg>
  ),
}

function NavRow({ item, active }: { item: NavItemDef; active: boolean }) {
  return (
    <Link
      href={item.href}
      aria-current={active ? 'page' : undefined}
      className="flex items-center gap-3 px-3 py-2.5 rounded-[6px] transition-colors text-sm"
      style={{
        color: active ? 'var(--text-primary)' : 'var(--text-secondary)',
        background: active ? 'var(--bg-elevated)' : 'transparent',
        fontWeight: active ? 600 : 500,
      }}
    >
      <span style={{ color: active ? 'var(--orange-primary)' : 'currentColor' }}>{item.icon}</span>
      <span className="truncate">{item.label}</span>
    </Link>
  )
}

export default function NavRail() {
  const pathname = usePathname()

  return (
    <nav
      className="hidden md:flex md:flex-col w-[220px] flex-shrink-0 h-full px-2 py-4"
      style={{ background: 'var(--bg-shell)', borderRight: '0.5px solid var(--bg-border)' }}
      aria-label="Primary"
    >
      <div className="flex items-center justify-between px-3 pb-4 mb-1">
        <Link href="/today" className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-[4px] flex items-center justify-center text-xs font-bold" style={{ background: 'var(--orange-primary)', color: '#fff' }}>W</span>
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>WorkA</span>
        </Link>
        <NotificationsBell />
      </div>

      <Link
        href="/jobs?new=1"
        className="btn-primary flex items-center justify-center gap-2 mx-1 mb-2 py-2 text-sm"
        aria-label="Create a new job"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        New Job
      </Link>

      <button
        type="button"
        onClick={() => document.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))}
        className="flex items-center justify-between mx-1 mb-4 px-3 py-1.5 rounded-[6px] text-sm"
        style={{ background: 'var(--bg-elevated)', color: 'var(--text-tertiary)', border: '0.5px solid var(--bg-border)' }}
      >
        <span>Search…</span>
        <span className="text-[11px] font-medium">⌘K</span>
      </button>

      <div className="flex flex-col gap-0.5 flex-1">
        {NAV_ITEMS.map((item) => (
          <NavRow key={item.href} item={item} active={isActive(pathname, item.href)} />
        ))}
      </div>

      <div className="pt-2 mt-2" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
        <NavRow item={SETTINGS_ITEM} active={pathname.startsWith('/settings')} />
      </div>
    </nav>
  )
}

// ─── Mobile bottom tab bar ──────────────────────────────────────────────────
// Keep the same three destinations on mobile. Settings is available in Business.
const MOBILE_ITEMS = NAV_ITEMS

export function MobileTabBar() {
  const pathname = usePathname()
  return (
    <nav
      className="md:hidden flex items-stretch pb-safe"
      style={{ background: 'var(--bg-surface)', borderTop: '0.5px solid var(--bg-border)' }}
      aria-label="Primary"
    >
      {MOBILE_ITEMS.map((item) => {
        const active = isActive(pathname, item.href)
        return (
          <Link
            key={item.href}
            href={item.href}
            aria-current={active ? 'page' : undefined}
            className="flex-1 flex flex-col items-center gap-0.5 py-3 text-xs"
            style={{ color: active ? 'var(--orange-primary)' : 'var(--text-tertiary)' }}
          >
            {item.icon}
            {item.label}
          </Link>
        )
      })}
    </nav>
  )
}
