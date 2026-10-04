import type {Line,Revision} from './project-studio.ts'
import {estimateReadiness} from './studio-readiness.ts'
export const scopeTemplates = [
 ['preliminaries','Preliminaries','Site establishment, supervision and preliminaries'],
 ['demolition','Preliminaries','Demolition and existing building work'],
 ['earthworks','Structure','Excavation, ground conditions and disposal'],
 ['foundations','Structure','Foundations, piers and concrete'],
 ['frame','Structure','Structural frame and engineering'],
 ['roof','Envelope','Roof, rainwater goods and waterproofing'],
 ['facade','Envelope','External walls, insulation and cladding'],
 ['openings','Envelope','Windows and external doors'],
 ['linings','Interiors','Internal walls, doors and ceilings'],
 ['joinery','Interiors','Kitchen, pantry and other joinery'],
 ['finishes','Interiors','Flooring, tiling and painting'],
 ['fixtures','Interiors','Fixtures, fittings and appliances'],
 ['plumbing','Services','Plumbing, drainage and hot water'],
 ['electrical','Services','Electrical, lighting, data and solar'],
 ['mechanical','Services','Heating, cooling and ventilation'],
 ['lift','Services','Lift and specialist equipment'],
 ['external','Structure','External works, landscaping and connections'],
 ['fees','Preliminaries','Consultants, approvals, insurance and contingency'],
] as const
export type ScopeDecision={key:string;status:'unknown'|'included'|'excluded';note:string;lineIds:string[]}
export type ScopeDocument={name:string;pages:number;revision:string;status:'unreviewed'|'current'|'superseded';note:string}
export type ScopeReview={kind:'unknown'|'new-build'|'alterations'|'mixed';documents:ScopeDocument[];items:ScopeDecision[];benchmark?:{totalInclGST:number;source:string;scopeConfirmed:boolean}}
export function newScopeReview():ScopeReview{return {kind:'unknown',documents:[],items:scopeTemplates.map(([key])=>({key,status:'unknown',note:'',lineIds:[]}))}}
export function registerPlanSource(review:ScopeReview,name:string,page:number,revision=''):ScopeReview{
 if(review.documents.some(d=>d.name===name)||review.documents.length>=80)return review
 return {...review,documents:[...review.documents,{name:name.slice(0,250),pages:Math.max(1,Math.min(2000,page)),revision:revision.slice(0,200),status:'unreviewed',note:`Page ${page} imported for modelling. Confirm the total page count and the applicable revision.`}]}
}
export function scopeIssues(review:ScopeReview|undefined,r:Revision):string[]{
 if(!review)return []
 const issues:string[]=[]
 if(review.kind==='unknown')issues.push('Confirm whether this is a new build, alterations or a mixed project.')
 if(!review.documents.some(d=>d.status==='current'))issues.push('Confirm the current source documents for this estimate.')
 if(review.documents.some(d=>d.status==='unreviewed'))issues.push('Resolve unreviewed document revisions before accepting.')
 for(const [key,,name] of scopeTemplates){const item=review.items.find(s=>s.key===key)
  if(!item||item.status==='unknown')issues.push(`${name}: confirm included or excluded.`)
  else if(!item.note.trim())issues.push(`${name}: record the scope evidence or exclusion reason.`)
  else if(item.status==='included'&&!item.lineIds.some(id=>r.lines.some(l=>l.id===id&&l.included)))issues.push(`${name}: link included estimate items.`)
  if(item?.status==='excluded'&&item.lineIds.some(id=>r.lines.some(l=>l.id===id&&l.included)))issues.push(`${name}: excluded scope still has included estimate items.`)
  if(item?.lineIds.some(id=>!r.lines.some(l=>l.id===id)))issues.push(`${name}: an estimate item was removed; review the scope links.`)
 }
 return issues
}
/** Placeholders deliberately carry no invented quantity or rate. Never replace existing pricing. */
export function addScopePlaceholder(review:ScopeReview,r:Revision,key:string,id:string){
 const template=scopeTemplates.find(t=>t[0]===key),item=review.items.find(i=>i.key===key)
 if(!template||!item||item.status!=='included')throw new Error('Include this scope before adding an estimate item.')
 if(item.lineIds.some(link=>r.lines.some(l=>l.id===link)))throw new Error('Review the existing linked estimate items first.')
 const line:Line={id,trade:template[1],name:template[2],unit:'item',source:'entered',quantity:0,rate:0,allowance:true,included:true,rateVerified:false,note:'Scope placeholder: measure quantities and obtain pricing. '+item.note}
 return {lines:[...r.lines,line],review:{...review,items:review.items.map(i=>i.key===key?{...i,lineIds:[id]}:i)}}
}
export function benchmarkComparison(review:ScopeReview,r:Revision,total:number){
 const b=review.benchmark
 if(!b)return null
 const ready=estimateReadiness(r)
 return {benchmark:b.totalInclGST,estimate:total,difference:total-b.totalInclGST,comparable:b.scopeConfirmed&&!!b.source.trim()&&scopeIssues(review,r).length===0&&ready.modelReviewed&&ready.included>0&&!ready.unpriced&&!ready.missingQuantities&&!ready.uncheckedRates&&!ready.uncheckedQuantities}
}
export function validScopeReview(value:unknown):value is ScopeReview{
 const v=value as ScopeReview, text=(s:unknown,n:number)=>typeof s==='string'&&s.length<=n
 return !!v&&['unknown','new-build','alterations','mixed'].includes(v.kind)&&Array.isArray(v.documents)&&v.documents.length<=80&&v.documents.every(d=>!!d&&text(d.name,250)&&Number.isInteger(d.pages)&&d.pages>0&&d.pages<=2000&&text(d.revision,200)&&['unreviewed','current','superseded'].includes(d.status)&&text(d.note,2000))&&Array.isArray(v.items)&&v.items.length===scopeTemplates.length&&new Set(v.items.map(i=>i?.key)).size===scopeTemplates.length&&v.items.every(i=>!!i&&scopeTemplates.some(t=>t[0]===i.key)&&['unknown','included','excluded'].includes(i.status)&&text(i.note,2000)&&Array.isArray(i.lineIds)&&i.lineIds.length<=500&&i.lineIds.every(id=>text(id,100))&&new Set(i.lineIds).size===i.lineIds.length)&&(!v.benchmark||(Number.isFinite(v.benchmark.totalInclGST)&&v.benchmark.totalInclGST>0&&v.benchmark.totalInclGST<=1e9&&text(v.benchmark.source,2000)&&typeof v.benchmark.scopeConfirmed==='boolean'))
}
