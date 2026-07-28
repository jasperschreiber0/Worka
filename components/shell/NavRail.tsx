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
  {
    href: '/jobs',
    label: 'Jobs',
    icon: (
      <svg {...ICON_PROPS}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M3.75 9.75L12 4.5l8.25 5.25M4.5 10.5v8.25a1.5 1.5 0 001.5 1.5h3v-5.25h6V20.25h3a1.5 1.5 0 001.5-1.5V10.5" />
      </svg>
    ),
  },
  {
    href: '/team',
    label: 'Team',
    icon: (
      <svg {...ICON_PROPS}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M15 19.128a9.38 9.38 0 002.625.372 9.337 9.337 0 004.121-.952 4.125 4.125 0 00-7.533-2.493M15 19.128v-.003c0-1.113-.285-2.16-.786-3.07M15 19.128v.106A12.318 12.318 0 018.624 21c-2.331 0-4.512-.645-6.374-1.766l-.001-.109a6.375 6.375 0 0111.964-3.07M12 6.375a3.375 3.375 0 11-6.75 0 3.375 3.375 0 016.75 0zm8.25 2.25a2.625 2.625 0 11-5.25 0 2.625 2.625 0 015.25 0z" />
      </svg>
    ),
  },
  {
    href: '/suppliers',
    label: 'Suppliers',
    icon: (
      <svg {...ICON_PROPS}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M21 7.5l-9-5.25L3 7.5m18 0l-9 5.25M21 7.5v9l-9 5.25M3 7.5l9 5.25M3 7.5v9l9 5.25m0-9v9" />
      </svg>
    ),
  },
  {
    href: '/variations',
    label: 'Variations',
    icon: (
      <svg {...ICON_PROPS}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M9 12h3.75M9 15h3.75M9 18h3.75m3 .75H18a2.25 2.25 0 002.25-2.25V6.108c0-1.135-.845-2.098-1.976-2.192a48.424 48.424 0 00-1.123-.08m-5.801 0c-.065.21-.1.433-.1.664 0 .414.336.75.75.75h4.5a.75.75 0 00.75-.75 2.25 2.25 0 00-.1-.664m-5.8 0A2.251 2.251 0 0113.5 2.25H15c1.012 0 1.867.668 2.15 1.586m-5.8 0c-.376.023-.75.05-1.124.08C9.095 4.01 8.25 4.973 8.25 6.108V8.25m0 0H4.875c-.621 0-1.125.504-1.125 1.125v11.25c0 .621.504 1.125 1.125 1.125h9.75c.621 0 1.125-.504 1.125-1.125V9.375c0-.621-.504-1.125-1.125-1.125H8.25z" />
      </svg>
    ),
  },
  {
    href: '/chat',
    label: 'Assistant',
    icon: (
      <svg {...ICON_PROPS}>
        <path strokeLinecap="round" strokeLinejoin="round" d="M8.625 12a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H8.25m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0H12m4.125 0a.375.375 0 11-.75 0 .375.375 0 01.75 0zm0 0h-.375M21 12c0 4.556-4.03 8.25-9 8.25a9.764 9.764 0 01-2.555-.337A5.972 5.972 0 015.41 20.97a5.969 5.969 0 01-.474-.065 4.48 4.48 0 00.978-2.025c.09-.457-.133-.901-.467-1.226C3.93 16.178 3 14.189 3 12c0-4.556 4.03-8.25 9-8.25s9 3.694 9 8.25z" />
      </svg>
    ),
  },
]

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
        <Link href="/jobs" className="flex items-center gap-2">
          <span className="w-6 h-6 rounded-[4px] flex items-center justify-center text-xs font-bold" style={{ background: 'var(--orange-primary)', color: '#fff' }}>W</span>
          <span className="text-sm font-semibold" style={{ color: 'var(--text-primary)' }}>WorkA</span>
        </Link>
        <NotificationsBell />
      </div>

      <Link
        href="/jobs?new=1"
        className="btn-primary flex items-center justify-center gap-2 mx-1 mb-4 py-2 text-sm"
        aria-label="Create a new job"
      >
        <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
          <path strokeLinecap="round" strokeLinejoin="round" d="M12 4.5v15m7.5-7.5h-15" />
        </svg>
        New Job
      </Link>

      <div className="flex flex-col gap-0.5 flex-1">
        {NAV_ITEMS.map((item) => (
          <NavRow key={item.href} item={item} active={pathname === item.href || pathname.startsWith(item.href + '/')} />
        ))}
      </div>

      <div className="pt-2 mt-2" style={{ borderTop: '0.5px solid var(--bg-border)' }}>
        <NavRow item={SETTINGS_ITEM} active={pathname.startsWith('/settings')} />
      </div>
    </nav>
  )
}

// ─── Mobile bottom tab bar ──────────────────────────────────────────────────
// Rails collapse to bottom navigation on mobile (matches MobileJobSheet's
// existing gesture language) — 5 items max fit comfortably; Settings lives
// one level down (reachable from Jobs' overflow, or directly at /settings).
const MOBILE_ITEMS = [NAV_ITEMS[0], NAV_ITEMS[1], NAV_ITEMS[2], NAV_ITEMS[3], NAV_ITEMS[4]]

export function MobileTabBar() {
  const pathname = usePathname()
  return (
    <nav
      className="md:hidden flex items-stretch pb-safe"
      style={{ background: 'var(--bg-surface)', borderTop: '0.5px solid var(--bg-border)' }}
      aria-label="Primary"
    >
      {MOBILE_ITEMS.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + '/')
        return (
          <Link
            key={item.href}
            href={item.href}
            className="flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px]"
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
