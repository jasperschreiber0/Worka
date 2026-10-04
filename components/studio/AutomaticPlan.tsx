'use client'
import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '@/lib/studio-workspace'
import type { recognisedPlan } from '@/lib/studio-recognition'
import { revise } from '@/lib/project-studio'
import PlanModel from './PlanModel'

type Draft = ReturnType<typeof recognisedPlan>
export default function AutomaticPlan({ workspace: w, onChange }: { workspace: Workspace; onChange: (w: Workspace) => void }) {
  const [available, setAvailable] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [draft, setDraft] = useState<Draft | null>(null)
  const current = useRef(w), controller = useRef<AbortController | null>(null), generation = useRef(0)
  current.current = w
  const stamp = JSON.stringify([w.project.id, w.project.working, w.plan])
  const draftStamp = useRef('')
  useEffect(() => { const c = new AbortController(); void fetch('/api/studio/recognise', { signal: c.signal }).then(r => r.json()).then(v => { if (typeof v.available === 'boolean') setAvailable(v.available) }).catch(() => {}); return () => { c.abort(); controller.current?.abort() } }, [])
  useEffect(() => { generation.current++; controller.current?.abort(); setBusy(false); setDraft(null) }, [stamp])
  async function generate() {
    if (!w.plan) return
    const id = ++generation.current, started = stamp
    const c = new AbortController(); controller.current = c
    setBusy(true); setDraft(null); setMessage('Reading walls, dimensions and openings. This can take about a minute…')
    const timer = window.setTimeout(() => c.abort(), 205000)
    try {
      const response = await fetch('/api/studio/recognise', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(w.plan), signal: c.signal })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error || 'Unable to read this plan.')
      if (id !== generation.current) return
      draftStamp.current = started; setDraft(result); setMessage('Your draft model is ready. Compare it with the drawing, then use it in your project.')
    } catch (e) { if (id === generation.current) setMessage(c.signal.aborted ? 'Reading stopped. You can retry; your model is unchanged.' : e instanceof Error ? e.message : 'Unable to read this plan.') }
    finally { window.clearTimeout(timer); if (id === generation.current) setBusy(false) }
  }
  function apply() {
    const latest = current.current
    if (!draft || !latest.plan || draftStamp.current !== JSON.stringify([latest.project.id, latest.project.working, latest.plan])) { setDraft(null); setMessage('The project changed. Generate again using the current drawing.'); return }
    onChange({ ...latest, demo: false, plan: { ...latest.plan, metresPerUnit: draft.metresPerUnit, recognition: {warnings:draft.warnings} }, project: revise(latest.project, { design: draft.design }) })
    setDraft(null); setMessage('Draft applied. Check scale, wall heights and openings below. Existing wall-linked estimate items may need reconnecting.')
  }
  return <div className="wb-auto-plan">
    <h3>Drawing → editable 3D model</h3>
    <p>Choose a floor-plan page, then let Worka read its walls and openings. Review the draft, adjust it and download an image of any view.</p>
    {available === false && <p className="wb-notice" role="status">Automatic plan reading needs an AI connection on this installation. Connect the plan-reading service to enable generation. Manual tracing remains available.</p>}
    <div className="wb-toolbar"><button disabled={!w.plan || busy || available === false || (!!w.plan.role&&w.plan.role!=='floor-plan'&&w.plan.role!=='other')} onClick={() => void generate()}>{busy ? 'Creating draft model…' : 'Generate 3D from this page'}</button>{busy && <button onClick={() => { generation.current++; controller.current?.abort(); setBusy(false); setMessage('Reading cancelled. Your current model is unchanged.') }}>Cancel</button>}</div>
    <p className="wb-hint">The selected page is sent to Worka’s AI service when you generate. One floor at a time. A readable dimension or a manually confirmed scale is required. Draft quantities need review before estimating.</p>
    {!draft && w.plan?.recognition && <details><summary>Plan-reading assumptions to check</summary><ul>{w.plan.recognition.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul></details>}
    {message && <p role="status" className="wb-notice">{message}</p>}
    {draft && <><PlanModel design={draft.design} title="AI draft — measurements unverified"/><ul>{draft.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul><div className="wb-toolbar"><button onClick={apply}>Use this draft model</button><button onClick={() => { setDraft(null); setMessage('Draft discarded. Your current model is unchanged.') }}>Discard draft</button></div><p className="wb-hint">Using this draft replaces the working geometry. Accepted scope and saved options remain intact.</p></>}
  </div>
}
