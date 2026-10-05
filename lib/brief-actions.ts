import {createHash} from 'node:crypto'
import {stableJson} from './studio-json.ts'
import {estimateReadiness} from './studio-readiness.ts'
import {scopeIssues,scopeTemplates} from './studio-scope.ts'
import {revisionIssues} from './studio-workspace.ts'
import type {Workspace} from './studio-workspace.ts'
import {acceptedRevision,totals,round} from './project-studio.ts'
import {impactIssues} from './studio-change.ts'
import {projectCashForecast,validProjectTiming} from './studio-cash-forecast.ts'
import type {BriefAlert} from './morning-brief.ts'

export type BriefAction = BriefAlert & {key:string; jobKey:string; jobName:string; fingerprint:string}
export type SentActions = Record<string,{fingerprint:string;sentAt:string}>
export const MAX_BRIEF_ACTIONS=5
export function briefItemLabel(value:string):string{
  const name=value.split(/\s+[—–]\s+/)[0].trim()
  if(name.length<=85)return name
  return name.slice(0,82).replace(/\s+\S*$/,'')+'…'
}
export function testJob(...names:(string|undefined)[]):boolean {
  return names.some(n=>/^\s*(?:test(?:\s+only)?|qa|demo|sample|synthetic)(?:\s*[—–:\-]|\s+(?:test|job|project|house|live|workflow|only|worka|run|estimate)\b|\s*$)/i.test(n||''))
}
export function action(input:Omit<BriefAction,'fingerprint'>,state:unknown):BriefAction {
  return {...input,fingerprint:createHash('sha256').update(stableJson(state)).digest('hex')}
}
const rank={high:0,medium:1,low:2}
/** Select one actionable next step per job before suppressing reminders. A quiet
 * primary action must not cause lower-priority work to drip into daily emails. */
export function nextActions(actions:BriefAction[]):BriefAction[]{
  const seen=new Set<string>()
  return [...actions].sort((a,b)=>rank[a.priority]-rank[b.priority]||a.jobName.localeCompare(b.jobName)||a.key.localeCompare(b.key))
    .filter(a=>{if(testJob(a.jobName)||seen.has(a.jobKey))return false;seen.add(a.jobKey);return true})
}
export function dueActions(actions:BriefAction[],sent:SentActions,now:Date):BriefAction[]{
  return nextActions(actions).filter(a=>{const old=sent[a.key];return !old||old.fingerprint!==a.fingerprint||now.getTime()-Date.parse(old.sentAt)>=7*86400000}).slice(0,MAX_BRIEF_ACTIONS)
}
export function recordSent(sent:SentActions,all:BriefAction[],delivered:BriefAction[],now:Date):SentActions{
  const active=new Set(all.map(a=>a.key))
  const next:SentActions=Object.fromEntries(Object.entries(sent).filter(([key])=>active.has(key)))
  for(const a of delivered)next[a.key]={fingerprint:a.fingerprint,sentAt:now.toISOString()}
  return next
}
export type BriefWorkspace=Pick<Workspace,'name'|'address'|'demo'|'project'|'scopeReview'|'cashTiming'> & {planName?:string|null}
export function studioAction(w:BriefWorkspace):BriefAction|null{
  if(w.demo||testJob(w.name,w.address))return null
  const p=w.project,r=p.working,ready=estimateReadiness(r)
  const url=(view:string,focus='')=>`/studio?project=${p.id}&view=${view}${focus?`&focus=${focus}`:''}`
  const base={key:`studio:${p.id}`,jobKey:`studio:${p.id}`,jobName:w.name,entity_type:'studio',priority:'medium' as const}
  const make=(message:string,label:string,href:string,state:unknown)=>action({...base,message,action:label,href},state)
  if(!r.design.geometry)return make(w.planName?'Generate the 3D draft from your saved plans.':'Upload the floor plan to start this job.',w.planName?'Generate model':'Add plans',url('plan','setup'),['plans',!!w.planName])
  if(!ready.modelReviewed)return make('Check the dimensions, floors and openings against the plans.','Check 3D model',url('plan'),['model',r.design])
  const scope=w.scopeReview
  if(!scope||scopeIssues(scope,r).length){
    const item=scopeTemplates.find(([key])=>!scope?.items.some(i=>i.key===key&&i.status!=='unknown'&&i.note.trim()))
    const message=!scope||scope.kind==='unknown'?'Confirm whether this is a new build, alterations or both.':!scope.documents.some(d=>d.status==='current')||scope.documents.some(d=>d.status==='unreviewed')?'Confirm which drawing revisions apply to this estimate.':item?`Confirm what is included for ${item[2].toLowerCase()}.`:'Check that the included work is linked to estimate items.'
    return make(message,'Confirm scope',url('estimate','scope'),['scope',message,scope])
  }
  const items=[...r.lines].filter(l=>l.included).sort((a,b)=>a.name.localeCompare(b.name)||a.id.localeCompare(b.id))
  const price=items.find(l=>l.rate+(l.labour||0)<=0||!l.rateVerified)
  const issues=revisionIssues(r)
  if(issues.length)return make(price?`Confirm the price for ${briefItemLabel(price.name)}.`:'Check the quantities and costs for the included work.','Review costs',url('estimate','costs'),['costs',items,r.design])
  const accepted=acceptedRevision(p)
  if(accepted&&stableJson({...accepted,id:0})!==stableJson({...r,id:0})){
    const supported=revisionIssues(accepted).length===0&&impactIssues(accepted,r).length===0
    const a=totals(accepted),b=totals(r),money=(n:number)=>`${n<0?'−':'+'}${Math.abs(n).toLocaleString('en-AU',{style:'currency',currency:'AUD',minimumFractionDigits:2})}`
    let cash='Review payment timing before approval.'
    if(supported&&w.cashTiming&&validProjectTiming(w.cashTiming)&&w.cashTiming.costGstPercent!==null){
      const before=projectCashForecast(w as Workspace,w.cashTiming,'accepted'),after=projectCashForecast(w as Workspace,w.cashTiming,'proposed')
      cash=`Cash scenario: receipts ${money(round(after.receipts-before.receipts))}; payments ${money(round(after.payments-before.payments))}, including the saved GST allowance. Check the stage dates.`
    }
    const message=supported?`Proposed change: client price ${money(round(b.total-a.total))} including GST; estimated gross profit ${money(round(b.profit-a.profit))} excluding GST. ${cash}`:'Review the proposed change and its construction impacts before relying on the price difference.'
    return make(message,'Review variation & cash flow',url('financials'),['variation',r,accepted,w.cashTiming])
  }
  if(!accepted)return make('Check the final scope, allowances and exclusions before sharing this estimate.','Review estimate',url('estimate','share'),['review',r,scope])
  if(!w.cashTiming||w.cashTiming.costGstPercent===null)return make('Set payment dates and the GST allowance on costs to prepare cash flow.','Set up cash flow',url('financials'),['cash-setup',w.cashTiming])
  // A completed, unchanged job does not need a daily congratulatory email.
  return null
}
