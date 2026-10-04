import type {PlanSource} from './studio-workspace.ts'
import type {recognisedSet} from './studio-set-recognition.ts'

/** Each correction receives its own server budget. Never retry a transport or authentication failure. */
export async function generateBuildingDraft(pages:PlanSource[],signal:AbortSignal,onProgress:(message:string)=>void,request:typeof fetch=fetch,progress?:{previousDraft?:unknown;save:(draft:unknown,error:string)=>Promise<void>}):Promise<ReturnType<typeof recognisedSet>> {
 let previousDraft:unknown=progress?.previousDraft
 for(let attempt=0;attempt<3;attempt++){
  signal.throwIfAborted()
  const response=await request('/api/studio/recognise-set',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pages,...(previousDraft?{previousDraft}:{})}),signal})
  const data=await response.json()
  signal.throwIfAborted()
  if(response.ok)return data
  const repairable=response.status===422&&data.rejectedDraft&&JSON.stringify(data.rejectedDraft).length<=200000
  if(repairable&&progress)await progress.save(data.rejectedDraft,String(data.error||'Review needed').slice(0,5000))
  signal.throwIfAborted()
  if(attempt<2&&repairable){
   previousDraft=data.rejectedDraft
   onProgress('Checking and correcting the 3D draft against your drawings. This can take another few minutes…')
   continue
  }
  throw new Error(data.error||'Building generation did not finish. Your saved plans are unchanged.')
 }
 throw new Error('The building draft still needs review.')
}
