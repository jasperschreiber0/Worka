import {lineCost,round,totals,sameRevision,revise} from './project-studio.ts'
import type {Revision,Line} from './project-studio.ts'
import type {Workspace} from './studio-workspace.ts'
import {allRooms} from './studio-geometry.ts'

export type BudgetChoice={id:string;lineId:string;title:string;priority:'keep'|'flexible'|'remove';replacement:number;extra:number;reviewed:boolean;reference:string;floorRooms:string[];note:string}
export type BudgetPlan={base:Revision;target:number;choices:BudgetChoice[]}
// This first version is an explainable rules-based planner, not an AI take-off.
export function eligibleBudgetLine(l:Line){return l.included&&l.trade==='Interiors'&&l.source==='entered'&&!l.packageId&&!/budget alternative applied/i.test(l.note)&&!/structur|waterproof|fire.?rat|insulat|accessib|balustr|plumb|electri|lift|conting|reserve|rerout|relocat/i.test(l.name)&&/joinery|cabinet|floor finishes|ceiling|appliance|benchtop/i.test(l.name)}
export function createBudgetPlan(base:Revision):BudgetPlan{
 const choices=base.lines.filter(eligibleBudgetLine).filter(l=>lineCost(l,base.design)>0).map(l=>{
  const flooring=/floor finishes/i.test(l.name),percent=/joinery|cabinet/i.test(l.name)?15:flooring?10:5
  return {id:l.id,lineId:l.id,title:flooring?'Simpler dry-area floor selections':/joinery|cabinet/i.test(l.name)?'Simpler joinery and appliance selections':'Simpler ceiling and internal finish selections',priority:'flexible' as const,replacement:round(lineCost(l,base.design)*(1-percent/100)),extra:0,reviewed:false,reference:'',floorRooms:[] as string[],note:`Illustrative ${percent}% allowance reduction only; no supplier quote. Keep all essential work, stairs, services and required performance. Review the whole bundled item and all replacement/design costs. No geometry is removed.`}
 })
 return {base:structuredClone(base),target:round(totals(base).total*.9),choices}
}
export function validBudget(plan:any,revisionValid:(r:any)=>boolean):plan is BudgetPlan{
 const cash=(n:any)=>typeof n==='number'&&Number.isFinite(n)&&n>=0&&n<=1e9
 return !!plan&&revisionValid(plan.base)&&cash(plan.target)&&Array.isArray(plan.choices)&&plan.choices.length<=500&&new Set(plan.choices.map((c:any)=>c.id)).size===plan.choices.length&&new Set(plan.choices.map((c:any)=>c.lineId)).size===plan.choices.length&&plan.choices.every((c:any)=>c&&typeof c.id==='string'&&c.id.length<=100&&typeof c.lineId==='string'&&c.lineId.length<=100&&typeof c.title==='string'&&c.title.length<=500&&['keep','flexible','remove'].includes(c.priority)&&cash(c.replacement)&&cash(c.extra)&&typeof c.reviewed==='boolean'&&typeof c.reference==='string'&&c.reference.length<=1000&&typeof c.note==='string'&&c.note.length<=2000&&Array.isArray(c.floorRooms)&&c.floorRooms.length<=100&&c.floorRooms.every((s:any)=>typeof s==='string'&&s.length<=100))
}
export function budgetPreview(plan:BudgetPlan,mode:'finishes'|'balanced'|'maximum'='balanced'){
 const base=plan.base, original=totals(base),result=structuredClone(base),selected:BudgetChoice[]=[]
 const choices=plan.choices.filter(c=>base.lines.some(l=>l.id===c.lineId&&eligibleBudgetLine(l))&&c.priority!=='keep'&&(mode!=='finishes'||c.priority==='flexible')).sort((a,b)=>(a.priority==='remove'?0:1)-(b.priority==='remove'?0:1)||(lineCost(base.lines.find(l=>l.id===b.lineId)!,base.design)-b.replacement-b.extra)-(lineCost(base.lines.find(l=>l.id===a.lineId)!,base.design)-a.replacement-a.extra))
 for(const c of choices){
  if(mode!=='maximum'&&totals(result).total<=plan.target)break
  const l=result.lines.find(l=>l.id===c.lineId)
  if(!l||!eligibleBudgetLine(l)||!Number.isFinite(c.replacement+c.extra)||c.replacement<0||c.extra<0||c.replacement+c.extra<=0||c.replacement+c.extra>=lineCost(l,result.design))continue
  const replacement=round(c.replacement+c.extra)
  Object.assign(l,{source:'entered',quantity:1,unit:'item',rate:replacement,labour:0,waste:0,rateVerified:c.reviewed&&!!c.reference.trim(),allowance:!(c.reviewed&&c.reference.trim()),note:(l.note+'\nBudget alternative applied: '+c.title+'. Replacement '+c.replacement+' + associated work '+c.extra+'. '+c.note+' Reference: '+c.reference).slice(0,4000)})
  if(/floor finishes/i.test(l.name)&&result.design.geometry)for(const room of allRooms(result.design.geometry))if(c.floorRooms.includes(room.id)&&room.finish==='oak'&&!/bath|ensuite|kitchen|laundry|balcony|patio|alfresco/i.test(room.name))room.finish='carpet'
  selected.push(c)
 }
 const after=totals(result)
 return {revision:result,selected,original,after,saving:round(original.total-after.total),gap:round(Math.max(0,after.total-plan.target)),provisional:selected.some(c=>!c.reviewed||!c.reference.trim())}
}
export function applyBudget(w:Workspace,plan:BudgetPlan,mode:'finishes'|'balanced'|'maximum'){
 if(!sameRevision(w.project.working,plan.base))throw new Error('Estimate changed. Refresh budget choices before applying.')
 if(w.options.length>10)throw new Error('Keep two free option slots for the original and budget proposal.')
 const preview=budgetPreview(plan,mode)
 if(!preview.selected.length)throw new Error('No costed changes selected.')
 const now=new Date().toISOString(),id=()=>globalThis.crypto.randomUUID()
 const {id:revisionId,...revision}=preview.revision
 const next:Workspace={...w,budget:undefined,options:[...w.options,{id:id(),name:'Before budget review',revision:structuredClone(plan.base),savedAt:now},{id:id(),name:'Budget proposal — '+(preview.provisional?'provisional':'builder reviewed'),revision:structuredClone(preview.revision),savedAt:now}],project:revise(w.project,revision)}
 return next
}
