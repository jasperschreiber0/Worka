import {validProjectTiming} from './studio-cash-forecast.ts'
import type {ProjectCashTiming} from './studio-cash-forecast.ts'
import {validModelProgress} from './studio-model-progress.ts'
import type {ModelProgress} from './studio-model-progress.ts'
import {validDocumentReadings} from './studio-document-reading.ts'
import type {DocumentReading} from './studio-document-reading.ts'
import {validScopeReview,scopeIssues,newScopeReview} from './studio-scope.ts'
import type {ScopeReview} from './studio-scope.ts'
import {validVectorDimensions} from './studio-vector-scale.ts'
import type {VectorDimension} from './studio-vector-scale.ts'
import {validDrawingText} from './studio-drawing-text.ts'
import type {DrawingText} from './studio-drawing-text.ts'
import {validBudget} from './studio-budget.ts'
import type {BudgetPlan} from './studio-budget.ts'
import {validLessons} from './studio-learning.ts'
import type {RateLesson} from './studio-learning.ts'
import {impactIssues,changeImpact} from './studio-change.ts'
import {validSiteReport} from './studio-site.ts'
import type {SiteReport} from './studio-site.ts'
import {validBuilding,publicBuilding} from './studio-building.ts'
import { createDemoProject, parseProject, totals, quotePackages, quantity, acceptEstimate, approveVariation, revise, sameRevision, acceptedRevision } from './project-studio.ts'
import type { StudioProject, Revision, Line } from './project-studio.ts'
import { geometryBounds, simplePolygon, validOpening, length, levels, allWalls, allRooms, unresolvedChecks } from './studio-geometry.ts'
import type { Point } from './studio-geometry.ts'

export type PlanSource = { originalId?:string; vectorDimensions?:VectorDimension[]; text?:DrawingText[]; name:string; page:number; role?:'floor-plan'|'elevation'|'section'|'survey'|'other'; revision?:string; image:string; aspect:number; metresPerUnit:number; recognition?: {warnings:string[]}; calibration?: {a:Point;b:Point;metres:number} }
export type SavedOption = { id:string; name:string; revision:Revision; savedAt:string }
export type Approval = { revision:number; name:string; reference:string; at:string; kind:'baseline'|'variation' }
export type Workspace = { format:2; cashTiming?:ProjectCashTiming; modelProgress?:ModelProgress; documentReadings?:DocumentReading[]; scopeReview?:ScopeReview; budget?:BudgetPlan; lessons?:RateLesson[]; name:string; address:string; builder:string; demo:boolean; project:StudioProject; plan:PlanSource|null; drawings?:PlanSource[]; siteReport?:SiteReport; setReview?:{at:string;warnings:string[]}; options:SavedOption[]; approvals:Approval[]; rates:Line[] }
export type Snapshot = { at:string; label:string; workspace:Workspace }
export type StoredWorkspace = { version:number; workspace:Workspace; history:Snapshot[] }
export const uid=()=>globalThis.crypto.randomUUID()
export function newWorkspace(demo=false):Workspace {
  const project=createDemoProject()
  if(!demo){project.id=uid();project.working.lines=[];project.costs=project.costs.map(c=>({...c,committed:0,actual:0}));project.working.exclusions='';project.working.design={width:8,depth:6,height:2.7}}
  return {format:2,name:demo?'Gumtree House':'Untitled project',address:demo?'Blue Mountains, NSW':'',builder:demo?'Gumtree Building Co.':'',demo,project,plan:null,options:[],approvals:[],rates:[]}
}
/** New jobs reuse reviewed library rates, never another job's scope or geometry. */
export function newPlanProject(previous:Workspace,name:string,address:string):Workspace {
 if(!name.trim()||name.trim().length>200||address.length>500)throw new Error('Enter a project name up to 200 characters and a shorter address.')
 const next=newWorkspace(false);next.name=name.trim();next.address=address.trim();next.builder=previous.builder;next.scopeReview=newScopeReview()
 next.rates=previous.rates.filter(l=>l.rateVerified).map(l=>{const copy=structuredClone(l);delete copy.wallId;delete copy.roomId;delete copy.packageId;delete copy.packagePart;delete copy.packageName;return {...copy,id:uid(),source:'entered' as const,quantity:1}})
 next.project.working.exclusions='Draft for review. Confirm scope, site access, ground conditions, structural requirements, finish level, services, allowances and exclusions with the builder. Uploaded plans and generated geometry require measurement review. No prices from another project have been assumed.'
 return next
}
export function migrateDemo(raw:string):Workspace|null {const project=parseProject(raw);return project?{...newWorkspace(true),project}:null}
export function revisionIssues(r:Revision) {
  const issues:string[]=[]
  if(!r.lines.some(l=>l.included))issues.push('Add at least one included scope item.')
  if(r.lines.some(l=>l.included&&l.rate+(l.labour||0)<=0))issues.push('Price every included item, or exclude it from this estimate.')
  if(r.design.geometry && levels(r.design.geometry).some(l=>!l.geometry.verified))issues.push('Verify the traced measurements before accepting.')
  if(!r.design.geometry)issues.push('Verify the footprint and walls in Plan setup before accepting.')
  if(r.lines.some(l=>l.included && l.quantityVerified===false))issues.push('Review extracted quantities and units against their source documents.')
  if(r.lines.some(l=>l.included && !l.rateVerified))issues.push('Check the rates and mark each included item as reviewed.')
  if(r.lines.some(l=>l.included && l.wallId && !(r.design.geometry&&allWalls(r.design.geometry).some(w=>w.id===l.wallId))))issues.push('Reconnect scope items whose linked wall was removed.')
  if(r.design.geometry&&unresolvedChecks(r.design.geometry).length)issues.push('Resolve dimension discrepancies before accepting.')
  if(r.lines.some(l=>l.included&&l.roomId&&!(r.design.geometry&&allRooms(r.design.geometry).some(room=>room.id===l.roomId))))issues.push('Reconnect scope items whose linked room was removed.')
  if(r.lines.some(l=>l.included&&quantity(l,r.design)<=0))issues.push('Enter or reconnect quantities for included items with zero quantity.')
  return issues
}
export function approvalIssues(w:Workspace){const from=acceptedRevision(w.project);return [...revisionIssues(w.project.working),...scopeIssues(w.scopeReview,w.project.working),...(from?impactIssues(from,w.project.working):[])]}
export function recordApproval(w:Workspace,name:string,reference:string,variationId?:string):Workspace {
  if(!name.trim()||!reference.trim())throw new Error('Enter the approver’s name and evidence reference.')
  const issues=approvalIssues(w)
  if(issues.length && !w.demo)throw new Error(issues[0])
  if(variationId){const v=w.project.variations.find(v=>v.id===variationId);if(!v || v.status!=='draft'||!sameRevision(v.to,w.project.working))throw new Error('Refresh the variation before recording approval.')}
  const project=variationId?approveVariation(w.project,variationId):acceptEstimate(w.project)
  if(project===w.project)throw new Error('There is no new scope to accept.')
  return {...w,project,approvals:[...w.approvals,{revision:project.working.id,name:name.trim(),reference:reference.trim(),at:new Date().toISOString(),kind:variationId?'variation':'baseline'}]}
}
export function restoreOption(w:Workspace,option:SavedOption):Workspace {const {id,...revision}=structuredClone(option.revision);return {...w,project:revise(w.project,revision)}}

// A public payload is built by allow-list. Never send internal revisions, unit costs or margins.
export function clientProjection(w:Workspace) {
  const project=(r:Revision)=>({revision:r.id,reviewRequired:revisionIssues(r).length>0,design:r.design,price:totals(r).price,gst:totals(r).gst,total:totals(r).total,exclusions:r.exclusions,packages:quotePackages(r).map(p=>({trade:p.trade,price:p.price,items:p.lines.map(l=>({name:l.name,quantity:quantity(l,r.design),unit:l.unit,allowance:l.allowance}))}))})
  const cleanDesign=(r:Revision)=>({width:r.design.width,depth:r.design.depth,height:r.design.height,...(r.design.geometry?{geometry:publicBuilding(r.design.geometry)}:{})})
  const clean=(r:Revision)=>({...project(r),design:cleanDesign(r)})
  const accepted=acceptedRevision(w.project)
  const difference=accepted?changeImpact(accepted,w.project.working):null
  const changes=difference?{fromRevision:accepted!.id,toRevision:w.project.working.id,totalDelta:difference.totalDelta,designChanged:difference.designChanged,exclusionsChanged:difference.exclusionsChanged,reviewRequired:approvalIssues(w).length>0,rows:difference.rows.map(({name,unit,beforeUnit,before,after,status})=>({name,unit,beforeUnit,before,after,status}))}:null
  return {changes,accepted:accepted?clean(accepted):null,name:w.name,address:w.address,builder:w.builder,demo:w.demo,current:{...clean(w.project.working),reviewRequired:approvalIssues(w).length>0},options:w.options.map(o=>({id:o.id,name:o.name,...clean(o.revision)})),status:accepted?(sameRevision(accepted,w.project.working)?'Accepted scope recorded by builder':'Proposed revision — only recorded approvals change the contract'):'For discussion — not yet accepted'}
}
export type ClientProjection=ReturnType<typeof clientProjection>

/** Validate imported/network data before any calculation, geometry allocation or persistence. */
export function parseWorkspace(value:unknown):Workspace|null {
  try {
    const w=typeof value==='string'?JSON.parse(value):structuredClone(value)
    const str=(v:unknown,n=500)=>typeof v==='string'&&v.length<=n
    const num=(v:unknown,min=0,max=1e7)=>typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max
    const point=(p:any)=>p&&num(p.x,-20000,20000)&&num(p.y,-20000,20000)
    const line=(l:any)=>l&&str(l.id,100)&&str(l.name)&&str(l.note,4000)&&str(l.unit,20)&&['Preliminaries','Structure','Envelope','Interiors','Services'].includes(l.trade)&&['entered','area','perimeter','wall-area','wall-length','openings','room-area','roof-area'].includes(l.source)&&num(l.quantity)&&num(l.rate)&&typeof l.included==='boolean'&&typeof l.allowance==='boolean'&&(l.labour===undefined||num(l.labour))&&(l.waste===undefined||num(l.waste,0,100))&&(l.supplier===undefined||str(l.supplier,2000))&&(l.roomId===undefined||str(l.roomId,100))&&(l.packagePart===undefined||str(l.packagePart,200))&&(l.packageId===undefined||str(l.packageId,100))&&(l.packageName===undefined||str(l.packageName,200))&&(l.wallId===undefined||str(l.wallId,100))&&(l.quantityVerified===undefined||typeof l.quantityVerified==='boolean')&&(l.rateVerified===undefined||typeof l.rateVerified==='boolean')
    const revision=(r:any)=> {
      if(!r||!Number.isInteger(r.id)||!num(r.id)||!num(r.markup,0,100)||!str(r.exclusions,8000)||!Array.isArray(r.lines)||r.lines.length>500||!r.lines.every(line)||new Set(r.lines.map((l:any)=>l.id)).size!==r.lines.length)return false
      if(r.impactReview!==undefined&&(!Array.isArray(r.impactReview)||r.impactReview.length>5||r.impactReview.some((c:any)=>!c||!str(c.topic,100)||!['included','excluded','unaffected'].includes(c.status)||!str(c.note,2000)||!str(c.signature,1000000))))return false
      const d=r.design,g=d?.geometry
      if(!d||!num(d.width,.1,100)||!num(d.depth,.1,100)||!num(d.height,.5,12))return false
      if(!g)return true
      if(!validBuilding(g))return false
      const bounds=geometryBounds(g)
      return Math.abs(bounds.width-d.width)<=.011&&Math.abs(bounds.depth-d.depth)<=.011
    }
    if(!w||w.format!==2||!str(w.name,200)||!str(w.address)||!str(w.builder,200)||typeof w.demo!=='boolean')return null
    if(w.documentReadings!==undefined&&!validDocumentReadings(w.documentReadings))return null
    if(w.scopeReview!==undefined&&!validScopeReview(w.scopeReview))return null
    if(w.cashTiming&&!validProjectTiming(w.cashTiming))return null
    if(w.modelProgress&&!validModelProgress(w.modelProgress))return null
    if(w.setReview&&(!Number.isFinite(Date.parse(w.setReview.at))||!Array.isArray(w.setReview.warnings)||w.setReview.warnings.length>250||w.setReview.warnings.some((s:unknown)=>!str(s,1200))))return null
    if(w.siteReport&&!validSiteReport(w.siteReport))return null
    if(w.lessons!==undefined&&!validLessons(w.lessons))return null
    if(w.budget!==undefined&&!validBudget(w.budget,revision))return null
    const p=w.project
    if(!p||p.schema!==1||!str(p.id,100)||!/^[-a-zA-Z0-9]+$/.test(p.id)||!revision(p.working)||(p.baseline!==null&&!revision(p.baseline)))return null
    if(!Array.isArray(p.variations)||p.variations.length>100)return null
    let prior=p.baseline,draft=false
    const ids=new Set()
    for(const v of p.variations){if(!prior||draft||!str(v.id,100)||ids.has(v.id)||!['draft','approved'].includes(v.status)||!revision(v.from)||!revision(v.to)||!sameRevision(prior,v.from)||!Number.isFinite(Date.parse(v.createdAt))||(v.status==='approved'&&!Number.isFinite(Date.parse(v.approvedAt))))return null;ids.add(v.id);if(v.status==='draft')draft=true;else prior=v.to}
    if(!Array.isArray(p.costs)||p.costs.length!==5||new Set(p.costs.map((c:any)=>c.trade)).size!==5||p.costs.some((c:any)=>!['Preliminaries','Structure','Envelope','Interiors','Services'].includes(c.trade)||!num(c.actual)||!num(c.committed)||(c.remaining!==undefined&&!num(c.remaining))||(c.complete!==undefined&&typeof c.complete!=='boolean')))return null
    if(!Array.isArray(p.receipts)||p.receipts.length!==6||!p.receipts.every((r:any)=>num(r)))return null
    const validPlan=(s:any)=>{if(!s||!str(s.name)||!Number.isInteger(s.page)||!num(s.page,1,1000)||!num(s.aspect,.05,20)||!num(s.metresPerUnit,0,1)||!str(s.image,3500000)||!/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s.image))return false;if(s.originalId!==undefined&&(typeof s.originalId!=='string'||!/^[a-f0-9]{64}$/.test(s.originalId)))return false;if(s.vectorDimensions!==undefined&&!validVectorDimensions(s.vectorDimensions,s.aspect))return false;if(s.text!==undefined&&!validDrawingText(s.text,s.aspect))return false;if(s.role!==undefined&&!['floor-plan','elevation','section','survey','other'].includes(s.role))return false;if(s.revision!==undefined&&!str(s.revision,100))return false;if(s.recognition&&(!Array.isArray(s.recognition.warnings)||s.recognition.warnings.length>250||!s.recognition.warnings.every((v:unknown)=>str(v,1200))))return false;if(s.calibration&&(!point(s.calibration.a)||!point(s.calibration.b)||!num(s.calibration.metres,.01,100)||length(s.calibration.a,s.calibration.b)<1||Math.abs(s.metresPerUnit-s.calibration.metres/length(s.calibration.a,s.calibration.b))>1e-8))return false;return true}
    if(w.plan!==null&&!validPlan(w.plan))return null
    if(w.drawings&&(!Array.isArray(w.drawings)||w.drawings.length>8||!w.drawings.every(validPlan)||w.drawings.reduce((n:number,p:PlanSource)=>n+p.image.length,0)>8000000))return null
    if(!Array.isArray(w.options)||w.options.length>12||w.options.some((o:any)=>!str(o.id,100)||!str(o.name,100)||!revision(o.revision)||!Number.isFinite(Date.parse(o.savedAt))))return null
    if(!Array.isArray(w.rates)||w.rates.length>200||!w.rates.every(line)||!Array.isArray(w.approvals)||w.approvals.length>200||w.approvals.some((a:any)=>!num(a.revision)||!str(a.name,200)||!str(a.reference,2000)||!['baseline','variation'].includes(a.kind)||!Number.isFinite(Date.parse(a.at))))return null
    return w as Workspace
  }catch{return null}
}
