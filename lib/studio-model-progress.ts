import type {PlanSource} from './studio-workspace.ts'
export type ModelProgress={source:string;at:string;error:string;draft:unknown}
export function resumableModelDraft(draft:any):boolean {
 try{return !!draft&&Array.isArray(draft.floors)&&draft.floors.length>0&&draft.floors.length<=5&&JSON.stringify(draft).length<=200000}catch{return false}
}
export function validModelProgress(value:any):value is ModelProgress {
 return !!value&&/^[a-f0-9]{64}$/.test(value.source)&&Number.isFinite(Date.parse(value.at))&&typeof value.error==='string'&&value.error.length<=5000&&resumableModelDraft(value.draft)
}
export async function drawingFingerprint(pages:PlanSource[]){
 const bytes=new TextEncoder().encode(JSON.stringify(pages))
 return Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),b=>b.toString(16).padStart(2,'0')).join('')
}
