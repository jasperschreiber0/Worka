'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { useRouter } from 'next/navigation'

interface JobListItem {
  id: string
  address: string
  status: string
}

interface CommandItem {
  id: string
  label: string
  sublabel?: string
  group: 'action' | 'nav' | 'job'
  onSelect: () => void
}

const STATIC_ITEMS: Omit<CommandItem, 'onSelect'>[] = [
  { id: 'new-job', label: '+ New job', group: 'action' },
  { id: 'nav-jobs', label: 'Jobs', group: 'nav' },
  { id: 'nav-team', label: 'Team', group: 'nav' },
  { id: 'nav-suppliers', label: 'Suppliers', group: 'nav' },
  { id: 'nav-variations', label: 'Variations', group: 'nav' },
  { id: 'nav-chat', label: 'Assistant', group: 'nav' },
  { id: 'nav-settings', label: 'Settings', group: 'nav' },
]

// Global ⌘K / Ctrl+K palette — jump to any job by address, or to a section,
// without leaving the keyboard. Job list is fetched lazily (only once the
// palette is first opened) since most sessions never open it at all.
export default function CommandPalette() {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [jobs, setJobs] = useState<JobListItem[] | null>(null)
  const [activeIndex, setActiveIndex] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const loadJobs = useCallback(() => {
    if (jobs !== null) return
    fetch('/api/jobs')
      .then((res) => res.json())
      .then((data) => setJobs(data.jobs ?? []))
      .catch(() => setJobs([]))
  }, [jobs])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setOpen((prev) => !prev)
      } else if (e.key === 'Escape') {
        setOpen(false)
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [])

  useEffect(() => {
    if (open) {
      loadJobs()
      setQuery('')
      setActiveIndex(0)
      const t = setTimeout(() => inputRef.current?.focus(), 50)
      return () => clearTimeout(t)
    }
  }, [open, loadJobs])

  function go(path: string) {
    setOpen(false)
    router.push(path)
  }

  const staticItems: CommandItem[] = STATIC_ITEMS.map((item) => ({
    ...item,
    onSelect: () => {
      if (item.id === 'new-job') go('/jobs?new=1')
      else if (item.id === 'nav-jobs') go('/jobs')
      else if (item.id === 'nav-team') go('/team')
      else if (item.id === 'nav-suppliers') go('/suppliers')
      else if (item.id === 'nav-variations') go('/variations')
      else if (item.id === 'nav-chat') go('/chat')
      else if (item.id === 'nav-settings') go('/settings')
    },
  }))

  const jobItems: CommandItem[] = (jobs ?? []).map((job) => ({
    id: `job-${job.id}`,
    label: job.address,
    sublabel: job.status,
    group: 'job',
    onSelect: () => go(`/jobs/${job.id}`),
  }))

  const allItems = [...staticItems, ...jobItems]
  const q = query.trim().toLowerCase()
  const filtered = q ? allItems.filter((item) => item.label.toLowerCase().includes(q)) : allItems
  const clampedIndex = Math.min(activeIndex, Math.max(filtered.length - 1, 0))

  function handleInputKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActiveIndex((i) => Math.min(i + 1, filtered.length - 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActiveIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      filtered[clampedIndex]?.onSelect()
    }
  }

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center pt-[15vh] px-4"
      style={{ background: 'rgba(0,0,0,0.4)' }}
      onClick={() => setOpen(false)}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        className="w-full max-w-lg rounded-[10px] overflow-hidden"
        style={{ background: 'var(--bg-surface)', border: '0.5px solid var(--bg-border)', boxShadow: '0 16px 48px rgba(0,0,0,0.35)' }}
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="w-full px-4 py-3.5 text-sm outline-none"
          style={{ background: 'transparent', color: 'var(--text-primary)', borderBottom: '0.5px solid var(--bg-border)' }}
          placeholder="Jump to a job, or search Jobs, Team, Suppliers, Variations…"
          value={query}
          onChange={(e) => { setQuery(e.target.value); setActiveIndex(0) }}
          onKeyDown={handleInputKeyDown}
        />
        <div className="max-h-[360px] overflow-y-auto py-1.5">
          {filtered.length === 0 && (
            <div className="px-4 py-6 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>No matches.</div>
          )}
          {filtered.map((item, idx) => (
            <button
              key={item.id}
              type="button"
              onMouseEnter={() => setActiveIndex(idx)}
              onClick={() => item.onSelect()}
              className="w-full text-left px-4 py-2 flex items-center justify-between text-sm"
              style={{
                background: idx === clampedIndex ? 'var(--bg-elevated)' : 'transparent',
                color: 'var(--text-primary)',
              }}
            >
              <span className="truncate">{item.label}</span>
              {item.sublabel && (
                <span className="text-xs flex-shrink-0 ml-2" style={{ color: 'var(--text-tertiary)' }}>{item.sublabel}</span>
              )}
            </button>
          ))}
        </div>
      </div>
    </div>
  )
}
