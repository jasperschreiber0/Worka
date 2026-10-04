import type {Workspace} from './studio-workspace.ts'
import {allRooms,allWalls} from './studio-geometry.ts'
import {packageLines} from './studio-change.ts'
import {revise} from './project-studio.ts'
import type {Line} from './project-studio.ts'
import {newScopeReview} from './studio-scope.ts'

/** Measured candidates only. Existing/retained work is never assumed to be new. */
export function prepareLinkedTakeoff(w:Workspace,priceAsNew:boolean){
 const g=w.project.working.design.geometry
 if(!g)throw new Error('Generate and inspect the building model first.')
 const review=structuredClone(w.scopeReview||newScopeReview()),lines:Line[]=[],skipped:string[]=[]
 let reusedRates=0
 for(const [template,elements] of [['wall',allWalls(g)],['floor',allRooms(g)]] as const){
  for(const element of elements){
   if(w.project.working.lines.some(l=>l.wallId===element.id||l.roomId===element.id)){skipped.push(element.name);continue}
   for(const line of packageLines(template,element.id,element.name,()=>crypto.randomUUID())){
    const candidates=w.rates.filter(r=>r.rateVerified&&r.packageName===line.packageName&&r.packagePart===line.packagePart&&r.unit===line.unit)
    const unique=Array.from(new Set(candidates.map(r=>JSON.stringify([r.rate,r.labour||0,r.waste||0,r.supplier||'']))))
    const rate=unique.length===1?candidates[0]:undefined
    if(rate)reusedRates++
    const item:Line={...line,included:priceAsNew,quantityVerified:false,rate:rate?.rate||0,labour:rate?.labour||0,waste:rate?.waste||0,supplier:rate?.supplier,rateVerified:false,note:line.note+' Generated model takeoff: confirm proposed versus retained work and specification. '+(priceAsNew?'Provisionally priced as new work.':'Not included in the price until its construction scope is confirmed. ')+(rate?'Rate copied from reviewed package library; confirm applicability to this job.':unique.length>1?'Conflicting library rates; choose the applicable specification.':'No matching reviewed package rate.')}
    lines.push(item)
    const scope=line.packagePart==='Framing'?'frame':line.packagePart==='Insulation'?'facade':line.packagePart==='Internal lining'?'linings':'finishes'
    review.items.find(i=>i.key===scope)!.lineIds.push(item.id)
   }
  }
 }
 if(w.project.working.lines.length+lines.length>500)throw new Error('This model needs more than 500 estimate items. Add packages for selected elements instead.')
 if(!lines.length)return {workspace:w,added:0,reusedRates:0,skipped}
 return {workspace:{...w,scopeReview:review,project:revise(w.project,{lines:[...w.project.working.lines,...lines]})},added:lines.length,reusedRates,skipped}
}
