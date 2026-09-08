'use client'
import { useSearchParams } from 'next/navigation'
import { Suspense, useEffect, useState } from 'react'
import AppShell from '@/components/shell/AppShell'

export default function XeroSettingsPage() {
  return <Suspense fallback={<p role="status" className="p-8">Loading Xero settings…</p>}><XeroSettingsContent /></Suspense>
}

function XeroSettingsContent() {
  const params = useSearchParams()
  const [loading, setLoading] = useState(false)
  const [disabled, setDisabled] = useState(true)
  const [message, setMessage] = useState<string | null>(params.get('status') === 'connected' ? 'Xero is connected.' : params.get('status') === 'error' ? 'Xero could not be connected. Please try again.' : null)
  const [syncing, setSyncing] = useState(false)
  const [connections, setConnections] = useState<Array<{ id: string; organisation_name: string | null; status: string; last_synced_at: string | null }>>([])
  const [history, setHistory] = useState<Array<{ id: string; status: string; started_at: string; imported_count: number; failed_count: number }>>([])
  useEffect(() => { Promise.all([fetch('/api/xero/status').then(response => response.ok ? response.json() : null), fetch('/api/xero/history').then(response => response.ok ? response.json() : null)]).then(([status, runs]) => { setDisabled(!status || status.disabled === true); setConnections(status?.connections ?? []); setHistory(runs?.runs ?? []) }).catch(() => {}) }, [])
  async function connect() {
    setLoading(true)
    try {
      const response = await fetch('/api/xero/connect')
      const data = await response.json()
      if (data.auth_url) window.location.href = data.auth_url
      else setMessage(data.message ?? 'Xero setup is not complete yet.')
    } catch { setMessage('Could not start the Xero connection. Try again.') }
    finally { setLoading(false) }
  }
  async function sync() {
    setSyncing(true)
    try { const response = await fetch('/api/xero/sync', { method: 'POST' }); const data = await response.json(); setMessage(data.message) }
    catch { setMessage('Could not start the Xero sync. Try again.') }
    finally { setSyncing(false) }
  }
  return <AppShell><main className="max-w-2xl mx-auto px-4 py-8" style={{ color: 'var(--text-primary)' }}>
    <h1 className="text-2xl font-semibold">Xero</h1>
    <p className="mt-2 text-sm" style={{ color: 'var(--text-secondary)' }}>Connect the Xero organisation that belongs to your building business. Worka will use it for job costs, bills, invoices and payments.</p>
    <div className="card p-5 mt-6"><h2 className="font-semibold">Your Xero organisation</h2><p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>You authorise Xero directly. Worka never asks for your Xero password.</p>{connections.map(connection => <div key={connection.id} className="mt-5 p-4 rounded-md" style={{ background: 'var(--bg-elevated)' }}><p className="font-medium">{connection.organisation_name ?? 'Connected Xero organisation'}</p><p className="text-xs mt-1" style={{ color: connection.status === 'active' ? 'var(--status-green)' : 'var(--status-amber)' }}>{connection.status === 'active' ? (connection.last_synced_at ? `Connected · last synced ${new Date(connection.last_synced_at).toLocaleDateString('en-AU')}` : 'Connected · not synced yet') : 'Needs attention'}</p></div>)}<button onClick={connect} disabled={loading || disabled} className="btn-primary px-4 py-3 mt-5">{disabled ? 'Xero is unavailable' : loading ? 'Opening Xero…' : connections.length ? 'Connect another organisation' : 'Connect Xero'}</button>{message && <p className="text-sm mt-4" style={{ color: message.includes('connected') ? 'var(--status-green)' : 'var(--status-amber)' }}>{message}</p>}</div>
    {connections.length > 0 && <button onClick={sync} disabled={syncing || disabled} className="btn-secondary px-4 py-3 mt-4">{syncing ? 'Checking Xero…' : 'Sync now'}</button>}
    <a href="/settings/xero/mapping" className="inline-block text-sm underline mt-5">Review Xero items →</a>
    <div className="card p-5 mt-6"><h2 className="font-semibold">Sync history</h2><p className="text-sm mt-2" style={{ color: 'var(--text-secondary)' }}>See when Xero was checked and whether anything needs attention.</p><div className="space-y-2 mt-4">{history.map(run => <div key={run.id} className="flex items-center justify-between gap-3 text-sm"><span>{new Date(run.started_at).toLocaleString('en-AU')}</span><span style={{ color: run.failed_count ? 'var(--status-amber)' : 'var(--status-green)' }}>{run.status} · {run.imported_count} imported{run.failed_count ? ` · ${run.failed_count} failed` : ''}</span></div>)}{history.length === 0 && <p className="text-sm" style={{ color: 'var(--text-tertiary)' }}>No syncs yet.</p>}</div></div>
    <p className="text-xs mt-6" style={{ color: 'var(--text-tertiary)' }}>After connecting, you will choose which jobs and cost categories Worka should map. Nothing is imported until that mapping is confirmed.</p>
  </main></AppShell>
}
