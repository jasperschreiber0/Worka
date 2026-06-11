'use client'

import { useEffect, useRef, useState, useCallback } from 'react'
import { createPortal } from 'react-dom'
import type { Worker } from '@/lib/types/database.types'

// ─── Props ────────────────────────────────────────────────────────────────────

export interface WorkerModalProps {
  isOpen: boolean
  onClose: () => void
  worker: Worker
  inviteUrl: string
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function initials(name: string): string {
  return name.charAt(0).toUpperCase()
}

function capitalise(str: string): string {
  if (!str) return str
  return str.charAt(0).toUpperCase() + str.slice(1)
}

function truncateUrl(url: string, maxLen = 35): string {
  if (url.length <= maxLen) return url
  return url.slice(0, maxLen - 1) + '…'
}

// ─── Focusable selector for focus trap ───────────────────────────────────────

const FOCUSABLE_SELECTOR =
  'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'

// ─── Component ────────────────────────────────────────────────────────────────

function WorkerModalInner({ isOpen, onClose, worker, inviteUrl }: WorkerModalProps) {
  const [copied, setCopied] = useState(false)
  const [visible, setVisible] = useState(false)
  const [mounted, setMounted] = useState(false)
  const modalRef = useRef<HTMLDivElement>(null)
  const closeButtonRef = useRef<HTMLButtonElement>(null)
  const copyTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Animate in/out
  useEffect(() => {
    if (isOpen) {
      setMounted(true)
      // Small delay to let DOM paint before triggering transition
      const id = setTimeout(() => setVisible(true), 10)
      return () => clearTimeout(id)
    } else {
      setVisible(false)
      const id = setTimeout(() => setMounted(false), 250)
      return () => clearTimeout(id)
    }
  }, [isOpen])

  // Focus the close button when modal opens
  useEffect(() => {
    if (visible) {
      closeButtonRef.current?.focus()
    }
  }, [visible])

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose()
      }
      // Focus trap: Tab / Shift+Tab cycles within modal
      if (e.key === 'Tab' && modalRef.current) {
        const focusable = Array.from(
          modalRef.current.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)
        ).filter((el) => !el.hasAttribute('disabled'))

        if (focusable.length === 0) return
        const first = focusable[0]
        const last = focusable[focusable.length - 1]

        if (e.shiftKey) {
          if (document.activeElement === first) {
            e.preventDefault()
            last.focus()
          }
        } else {
          if (document.activeElement === last) {
            e.preventDefault()
            first.focus()
          }
        }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [isOpen, onClose])

  // Lock body scroll while open
  useEffect(() => {
    if (isOpen) {
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.overflow = ''
    }
    return () => {
      document.body.style.overflow = ''
    }
  }, [isOpen])

  // Cleanup copy timeout on unmount
  useEffect(() => {
    return () => {
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
    }
  }, [])

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(inviteUrl)
      setCopied(true)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
    } catch {
      // Fallback: select + execCommand
      const el = document.createElement('input')
      el.value = inviteUrl
      document.body.appendChild(el)
      el.select()
      document.execCommand('copy')
      document.body.removeChild(el)
      setCopied(true)
      if (copyTimeoutRef.current) clearTimeout(copyTimeoutRef.current)
      copyTimeoutRef.current = setTimeout(() => setCopied(false), 2000)
    }
  }, [inviteUrl])

  const handleSMS = useCallback(() => {
    const body = encodeURIComponent(`Hi ${worker.name}, here's your WorkA invite: ${inviteUrl}`)
    window.location.href = `sms:?body=${body}`
  }, [worker.name, inviteUrl])

  const handleWhatsApp = useCallback(() => {
    const text = encodeURIComponent(`Hi ${worker.name}, here's your WorkA invite: ${inviteUrl}`)
    window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener,noreferrer')
  }, [worker.name, inviteUrl])

  const handleEmail = useCallback(() => {
    const subject = encodeURIComponent('Your WorkA invite')
    const body = encodeURIComponent(`Hi ${worker.name}, here's your WorkA invite: ${inviteUrl}`)
    window.location.href = `mailto:${worker.email ?? ''}?subject=${subject}&body=${body}`
  }, [worker.name, worker.email, inviteUrl])

  const handleBackdropClick = useCallback(
    (e: React.MouseEvent<HTMLDivElement>) => {
      if (e.target === e.currentTarget) onClose()
    },
    [onClose]
  )

  if (!mounted) return null

  return (
    // Overlay
    <div
      className={[
        'fixed inset-0 z-50 flex items-end sm:items-center justify-center',
        'transition-opacity duration-200',
        visible ? 'opacity-100' : 'opacity-0',
      ].join(' ')}
      style={{ backgroundColor: 'rgba(0,0,0,0.6)' }}
      onClick={handleBackdropClick}
      aria-modal="true"
      role="dialog"
      aria-label={`Add crew member — ${worker.name}`}
    >
      {/* Modal panel */}
      <div
        ref={modalRef}
        className={[
          'relative w-full sm:max-w-md rounded-t-2xl sm:rounded-2xl shadow-2xl',
          'transition-transform duration-250 ease-out',
          visible
            ? 'translate-y-0 sm:scale-100 sm:opacity-100'
            : 'translate-y-full sm:scale-95 sm:opacity-0',
        ].join(' ')}
        style={{
          transitionDuration: '220ms',
          background: 'var(--bg-surface)',
          border: '0.5px solid var(--bg-border)',
        }}
      >
        {/* ── Header ─────────────────────────────────────────────── */}
        <div
          className="flex items-center justify-between px-5 pt-5 pb-4"
          style={{ borderBottom: '0.5px solid var(--bg-border)' }}
        >
          <h2 className="text-base font-semibold" style={{ color: 'var(--text-primary)' }}>
            Add crew
          </h2>
          <button
            ref={closeButtonRef}
            onClick={onClose}
            className="w-8 h-8 flex items-center justify-center rounded-full transition-colors"
            style={{ color: 'var(--text-tertiary)' }}
            aria-label="Close"
          >
            <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path
                d="M1 1l12 12M13 1L1 13"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        <div className="px-5 py-4 space-y-4">
          {/* ── Worker card ──────────────────────────────────────── */}
          <div
            className="flex items-center gap-3 rounded-xl px-4 py-3"
            style={{
              background: 'var(--bg-elevated)',
              border: '0.5px solid var(--bg-border)',
            }}
          >
            {/* Avatar */}
            <div
              className="w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0"
              style={{ background: 'var(--orange-primary)' }}
            >
              <span className="text-base font-bold leading-none" style={{ color: '#fff' }}>
                {initials(worker.name)}
              </span>
            </div>
            <div className="min-w-0">
              <p className="text-sm font-semibold leading-tight" style={{ color: 'var(--text-primary)' }}>
                {worker.name}
              </p>
              <p className="text-xs mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
                {capitalise(worker.role)}
                <span className="mx-1" style={{ color: 'var(--text-tertiary)' }}>·</span>
                <span className="font-medium" style={{ color: 'var(--orange-primary)' }}>
                  {capitalise(worker.status)}
                </span>
              </p>
            </div>
          </div>

          {/* ── Invite link ──────────────────────────────────────── */}
          <div>
            <p
              className="text-xs font-medium uppercase tracking-wide mb-1.5"
              style={{ color: 'var(--text-tertiary)' }}
            >
              Invite link
            </p>
            <div
              className="flex items-center gap-2 rounded-lg px-3 py-2"
              style={{
                background: 'var(--bg-elevated)',
                border: '0.5px solid var(--bg-border)',
              }}
            >
              <span
                className="flex-1 text-sm font-mono truncate select-all"
                style={{ color: 'var(--text-secondary)' }}
              >
                {truncateUrl(inviteUrl)}
              </span>
              <button
                onClick={handleCopy}
                className="flex-shrink-0 p-1.5 rounded-md transition-colors"
                style={{ color: 'var(--text-tertiary)' }}
                aria-label="Copy invite link"
                title="Copy invite link"
              >
                {copied ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                    style={{ color: 'var(--status-green)' }}
                  >
                    <path
                      d="M2 8l4 4 8-8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <rect
                      x="5"
                      y="5"
                      width="9"
                      height="9"
                      rx="1.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M11 5V3.5A1.5 1.5 0 009.5 2H3.5A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                )}
              </button>
            </div>
          </div>

          {/* ── Primary actions ──────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-2">
            <button
              onClick={handleSMS}
              className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
              style={{ background: 'var(--orange-primary)', color: '#fff' }}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
              >
                <path
                  d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              Send via SMS
            </button>
            <button
              onClick={handleCopy}
              className="flex items-center justify-center gap-2 px-3 py-2.5 rounded-lg text-sm font-medium transition-colors"
              style={{
                background: 'var(--bg-elevated)',
                color: 'var(--text-secondary)',
                border: '0.5px solid var(--bg-border)',
              }}
            >
              {copied ? (
                <>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                    style={{ color: 'var(--status-green)' }}
                  >
                    <path
                      d="M2 8l4 4 8-8"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  Copied!
                </>
              ) : (
                <>
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                  >
                    <rect
                      x="5"
                      y="5"
                      width="9"
                      height="9"
                      rx="1.5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                    />
                    <path
                      d="M11 5V3.5A1.5 1.5 0 009.5 2H3.5A1.5 1.5 0 002 3.5v6A1.5 1.5 0 003.5 11H5"
                      stroke="currentColor"
                      strokeWidth="1.5"
                      strokeLinecap="round"
                    />
                  </svg>
                  Copy link
                </>
              )}
            </button>
          </div>

          {/* ── Divider ──────────────────────────────────────────── */}
          <div className="flex items-center gap-3">
            <div className="flex-1 h-px" style={{ background: 'var(--bg-border)' }} />
            <span className="text-xs whitespace-nowrap" style={{ color: 'var(--text-tertiary)' }}>
              or share via
            </span>
            <div className="flex-1 h-px" style={{ background: 'var(--bg-border)' }} />
          </div>

          {/* ── Secondary share options ──────────────────────────── */}
          <div className="grid grid-cols-3 gap-2 pb-1">
            {/* WhatsApp */}
            <button
              onClick={handleWhatsApp}
              className="flex flex-col items-center gap-1.5 py-3 rounded-lg transition-colors"
              style={{
                background: 'var(--bg-elevated)',
                border: '0.5px solid var(--bg-border)',
                color: 'var(--text-secondary)',
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 32 32"
                fill="currentColor"
                aria-hidden="true"
                style={{ color: 'var(--status-green)' }}
              >
                <path d="M16 2C8.27 2 2 8.27 2 16c0 2.45.66 4.74 1.81 6.72L2 30l7.5-1.77A13.93 13.93 0 0016 30c7.73 0 14-6.27 14-14S23.73 2 16 2zm0 25.5c-2.17 0-4.2-.59-5.94-1.62l-.43-.25-4.45 1.05 1.08-4.34-.28-.45A11.44 11.44 0 014.5 16C4.5 9.6 9.6 4.5 16 4.5S27.5 9.6 27.5 16 22.4 27.5 16 27.5zm6.28-8.52c-.34-.17-2.01-1-2.33-1.11-.31-.11-.54-.17-.77.17-.22.34-.88 1.11-1.08 1.34-.2.22-.4.25-.74.08-.34-.17-1.44-.53-2.74-1.69-1.01-.9-1.7-2.02-1.9-2.36-.2-.34-.02-.53.15-.7.15-.15.34-.4.51-.59.17-.2.22-.34.34-.57.11-.22.06-.42-.03-.59-.08-.17-.77-1.85-1.05-2.53-.28-.67-.56-.57-.77-.58h-.66c-.22 0-.57.08-.88.42-.3.34-1.14 1.11-1.14 2.7s1.17 3.14 1.33 3.36c.17.22 2.3 3.52 5.58 4.93.78.34 1.39.54 1.86.69.78.25 1.49.21 2.05.13.63-.09 1.94-.79 2.21-1.56.28-.76.28-1.41.2-1.56-.08-.14-.3-.22-.64-.39z" />
              </svg>
              <span className="text-xs font-medium">WhatsApp</span>
            </button>

            {/* iMessage */}
            <button
              onClick={handleSMS}
              className="flex flex-col items-center gap-1.5 py-3 rounded-lg transition-colors"
              style={{
                background: 'var(--bg-elevated)',
                border: '0.5px solid var(--bg-border)',
                color: 'var(--text-secondary)',
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                style={{ color: 'var(--status-blue)' }}
              >
                <path
                  d="M20 2H4a2 2 0 00-2 2v18l4-4h14a2 2 0 002-2V4a2 2 0 00-2-2z"
                  fill="currentColor"
                />
              </svg>
              <span className="text-xs font-medium">iMessage</span>
            </button>

            {/* Email */}
            <button
              onClick={handleEmail}
              className="flex flex-col items-center gap-1.5 py-3 rounded-lg transition-colors"
              style={{
                background: 'var(--bg-elevated)',
                border: '0.5px solid var(--bg-border)',
                color: 'var(--text-secondary)',
              }}
            >
              <svg
                width="20"
                height="20"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                style={{ color: 'var(--text-tertiary)' }}
              >
                <path
                  d="M3 8l7.89 5.26a2 2 0 002.22 0L21 8M5 19h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z"
                  stroke="currentColor"
                  strokeWidth="1.75"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
              <span className="text-xs font-medium">Email</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

// ─── Portal wrapper ───────────────────────────────────────────────────────────

export default function WorkerModal(props: WorkerModalProps) {
  const [portalTarget, setPortalTarget] = useState<Element | null>(null)

  useEffect(() => {
    setPortalTarget(document.body)
  }, [])

  if (!portalTarget) return null
  return createPortal(<WorkerModalInner {...props} />, portalTarget)
}
