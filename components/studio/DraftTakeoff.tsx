'use client'
import {useState} from 'react'
import type {Workspace} from '@/lib/studio-workspace'
import {prepareLinkedTakeoff} from '@/lib/studio-draft-takeoff'
export default function DraftTakeoff({workspace:w,onChange}:{workspace:Workspace;onChange:(w:Workspace)=>void}){
 const [asNew,setAsNew]=useState(w.scopeReview?.kind==='new-build'),[message,setMessage]=useState('')
 return <details className="wb-card"><summary>Prepare costs from your model</summary><p>Create linked wall and room-floor items together. Worka reuses matching reviewed package rates; missing or conflicting rates remain unpriced. Foundations, roofs, services, joinery and other work still need their own scope.</p><label><input type="checkbox" checked={asNew} onChange={e=>setAsNew(e.target.checked)}/>Treat all shown walls and floor finishes as new work</label><p>{asNew?'Items will be provisionally included. Review quantities and specifications.':'Items will stay outside the price until you identify the work required. Use this for alterations with retained elements.'}</p><button disabled={!w.project.working.design.geometry} onClick={()=>{try{const result=prepareLinkedTakeoff(w,asNew);onChange(result.workspace);setMessage(`${result.added} linked items prepared; ${result.reusedRates} library rates reused. ${result.skipped.length} elements already had costs and were left unchanged. Review items in the cost breakdown.`)}catch(e){setMessage((e as Error).message)}}}>Prepare linked cost items</button>{message&&<p role="status">{message}</p>}</details>
}
