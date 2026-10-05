'use client'
import { useEffect, useRef, useState } from 'react'
import type { Workspace } from '@/lib/studio-workspace'
import type { recognisedPlan } from '@/lib/studio-recognition'
import { revise } from '@/lib/project-studio'
import PlanModel from './PlanModel'
import {floorDiagnostic} from './floor-diagnostic'
import {generateFloorStages,validFloorCheckpoint} from '@/lib/studio-floor-stages'
import {floorSupportingPages} from '@/lib/studio-page-index'
import {drawingFingerprint} from '@/lib/studio-model-progress'
import {prepareLinkedTakeoff} from '@/lib/studio-draft-takeoff'

type Draft = ReturnType<typeof recognisedPlan>
export default function AutomaticPlan({ workspace: w, onChange, onCheckpoint }: { workspace: Workspace; onChange: (w: Workspace) => void; onCheckpoint?: (w: Workspace) => Promise<void> }) {
  const [available, setAvailable] = useState<boolean | null>(null), [busy, setBusy] = useState(false), [message, setMessage] = useState(''), [draft, setDraft] = useState<Draft | null>(null)
  const current = useRef(w), controller = useRef<AbortController | null>(null), generation = useRef(0)
  current.current = w
  const stamp = JSON.stringify([w.project.id, w.project.working, w.plan, w.drawings])
  const draftStamp = useRef('')
  useEffect(() => { const c = new AbortController(); void fetch('/api/studio/recognise', { signal: c.signal }).then(r => r.json()).then(v => { if (typeof v.available === 'boolean') setAvailable(v.available) }).catch(() => {}); return () => { c.abort(); controller.current?.abort() } }, [])
  useEffect(() => { generation.current++; controller.current?.abort(); setBusy(false); setDraft(null) }, [stamp])
  async function generate() {
    if (!w.plan) return
    const id = ++generation.current, started = stamp
    const c = new AbortController(); controller.current = c
    setBusy(true); setDraft(null); setMessage('Reading this floor in steps. Progress is saved between steps; keep this page open…')
    const timer = window.setTimeout(() => c.abort(), 1500000)
    try {
      const supports=floorSupportingPages(w.plan,w.drawings)
      const source=await drawingFingerprint([w.plan,...supports])
      const previous=w.modelProgress?.source===source&&validFloorCheckpoint(w.modelProgress.draft,source)?w.modelProgress.draft:undefined
      const result=await generateFloorStages(w.plan,c.signal,setMessage,async(draft,error)=>{
        if(id!==generation.current)throw new Error('The drawing changed.')
        const updated={...current.current,modelProgress:{source,draft,error,at:new Date().toISOString()}}
        if(onCheckpoint)await onCheckpoint(updated)
        else onChange(updated)
      },previous,fetch,supports,floorDiagnostic)
      if (id !== generation.current) return
      draftStamp.current = started; setDraft(result); setMessage(result.warnings.some(s=>/^(Incomplete model:|(?:Area|Coverage) check required:)/.test(s))?'A partial draft is ready. Resolve the highlighted measurement and coverage checks before using quantities.':'Your draft model is ready. Compare it with the drawing, then use it in your project.')
    } catch (e) { if (id === generation.current) setMessage(c.signal.aborted ? 'Reading stopped. You can retry; your model is unchanged.' : e instanceof Error ? e.message : 'Unable to read this plan.') }
    finally { window.clearTimeout(timer); if (id === generation.current) setBusy(false) }
  }
  function apply() {
    const latest = current.current
    if (!draft || draft.warnings.some(s=>s.startsWith('Incomplete model:')) || !latest.plan || draftStamp.current !== JSON.stringify([latest.project.id, latest.project.working, latest.plan, latest.drawings])) { setDraft(null); setMessage('The project changed. Generate again using the current drawing.'); return }
    let next:Workspace={ ...latest, demo: false, modelProgress: undefined, plan: { ...latest.plan, metresPerUnit: draft.metresPerUnit, recognition: {warnings:draft.warnings} }, project: revise(latest.project, { design: draft.design }) }
    let note='Existing wall-linked estimate items may need reconnecting.'
    if(!latest.project.working.design.geometry){try{const prepared=prepareLinkedTakeoff(next,latest.scopeReview?.kind==='new-build');next=prepared.workspace;note=`${prepared.added} linked cost items prepared. Review scope and rates before using the estimate.`}catch(e){note=e instanceof Error?e.message:'Review estimate links.'}}
    onChange(next)
    setDraft(null); setMessage('Draft applied. Check scale, wall heights and openings below. '+note)
  }
  return <div className="wb-auto-plan">
    <h3>Drawing → editable 3D model</h3>
    <p>Choose a floor-plan page, then let Worka read its walls and openings. Review the draft, adjust it and download an image of any view.</p>
    {available === false && <p className="wb-notice" role="status">Automatic plan reading needs an AI connection on this installation. Connect the plan-reading service to enable generation. Manual tracing remains available.</p>}
    <div className="wb-toolbar"><button disabled={!w.plan || busy || available === false || (!!w.plan.role&&w.plan.role!=='floor-plan'&&w.plan.role!=='other')} onClick={() => void generate()}>{busy ? 'Creating draft model…' : (w.modelProgress?.draft as any)?.kind==='staged-floor-v1'&&(w.modelProgress?.draft as any)?.version===3?'Resume saved 3D reading':'Generate 3D from this page'}</button>{!busy&&w.modelProgress&&<button onClick={()=>{onChange({...current.current,modelProgress:undefined});setDraft(null);setMessage('Saved reading cleared. Your working model is unchanged; start a new reading when ready.')}}>Start a new reading</button>}{busy && <button onClick={() => { generation.current++; controller.current?.abort(); setBusy(false); setMessage('Reading cancelled. Your current model is unchanged.') }}>Cancel</button>}</div>
    <p className="wb-hint">The selected floor and up to seven saved supporting pages from the same PDF are sent to Worka’s AI service when you generate. One floor at a time. A readable dimension or a manually confirmed scale is required. Draft quantities need review before estimating.</p>
    {!draft && w.plan?.recognition && <details><summary>Plan-reading assumptions to check</summary><ul>{w.plan.recognition.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul></details>}
    {message && <p role="status" className="wb-notice">{message}</p>}
    {draft && <><PlanModel design={draft.design} title="AI draft — measurements unverified"/><div>{draft.warnings.filter(w=>/^(Incomplete model:|(?:Area|Coverage) check required:)/.test(w)).map((warning,i)=><p className="wb-notice" key={i}>{warning}</p>)}</div><details><summary>Measurements and assumptions to review ({draft.warnings.length})</summary><ul>{draft.warnings.map((warning, i) => <li key={i}>{warning}</li>)}</ul></details><div className="wb-toolbar"><button disabled={draft.warnings.some(s=>s.startsWith('Incomplete model:'))} onClick={apply}>Use this draft model</button><button onClick={() => { setDraft(null); setMessage('Draft discarded. Your current model is unchanged.') }}>Discard draft</button></div><p className="wb-hint">Using this draft replaces the working geometry. Accepted scope and saved options remain intact.</p></>}
  </div>
}
