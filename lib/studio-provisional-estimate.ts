import {quantity,revise,round,totals} from './project-studio.ts'
import type {Line} from './project-studio.ts'
import type {Workspace} from './studio-workspace.ts'
import {scopeTemplates} from './studio-scope.ts'

export type PricingGroup={id:string;name:string;trade:Line['trade'];unit:string;source:Line['source'];quantity:number;lineIds:string[];notes:string[]}
export function pricingGroups(w:Workspace):PricingGroup[]{
 const groups:PricingGroup[]=[],byKey=new Map<string,PricingGroup>()
 for(const l of w.project.working.lines){
  if(!l.included||l.rate+(l.labour||0)>0)continue
  // Measured wall packages have unique IDs, but identical work and specifications
  // can share a unit rate. Entered packages retain their separate identities.
  const name=l.name.split(' · ').at(-1)!.trim(),key=JSON.stringify([name.toLowerCase(),l.trade,l.unit,l.source,l.source==='entered'?l.packageId||'':'',l.note])
  let group=byKey.get(key)
  if(!group){group={id:'group-'+groups.length,name,trade:l.trade,unit:l.unit,source:l.source,quantity:0,lineIds:[],notes:[l.note]};groups.push(group);byKey.set(key,group)}
  group.quantity=round(group.quantity+quantity(l,w.project.working.design));group.lineIds.push(l.id)
 }
 return groups
}
export const provisionalSchema={type:'object',required:['groups','additional','assumptions'],properties:{
 groups:{type:'array',items:{type:'object',required:['id','unit','material','labour','basis'],properties:{id:{type:'string'},unit:{type:'string',description:'Exact supplied group unit. Both prices are per ONE unit, never multiplied by group quantity.'},material:{type:'number',description:'AUD ex GST material cost per ONE supplied unit, not group total.'},labour:{type:'number',description:'AUD ex GST labour cost per ONE supplied unit, not group total.'},basis:{type:'string'}}}},
 additional:{type:'array',maxItems:18,items:{type:'object',required:['scope','name','cost','basis'],properties:{scope:{type:'string',enum:scopeTemplates.map(s=>s[0])},name:{type:'string'},cost:{type:'number'},basis:{type:'string'}}}},
 assumptions:{type:'array',maxItems:8,items:{type:'string'}}
}}
const text=(v:unknown,max:number)=>typeof v==='string'&&v.trim().length>0&&v.length<=max
const price=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e7
export function applyProvisionalEstimate(w:Workspace,raw:any,at=new Date().toISOString()):Workspace{
 const groups=pricingGroups(w)
 if(!raw||!Array.isArray(raw.groups)||raw.groups.length!==groups.length||!Array.isArray(raw.additional)||raw.additional.length>18||!Array.isArray(raw.assumptions)||raw.assumptions.length>8||!raw.assumptions.every((s:unknown)=>text(s,500)))throw new Error('The pricing draft was incomplete. Your estimate has not changed.')
 const seen=new Set<string>(),prices=new Map<string,any>()
 for(const item of raw.groups){if(!item||!groups.some(g=>g.id===item.id&&g.unit===item.unit)||seen.has(item.id)||!price(item.material)||!price(item.labour)||item.material+item.labour<=0||!text(item.basis,1500))throw new Error('Invalid or duplicate pricing group. Your estimate has not changed.');seen.add(item.id);prices.set(item.id,item)}
 const replacements=new Map<string,any>();for(const g of groups)for(const id of g.lineIds)replacements.set(id,prices.get(g.id))
 const prefix=`PROVISIONAL AI ALLOWANCE · ${at.slice(0,10)} · AUD ex GST. Not a supplier quote or live market search. `
 const lines=w.project.working.lines.map(l=>{const p=replacements.get(l.id);return p?{...l,rate:p.material,labour:p.labour,waste:0,rateVerified:false,allowance:true,note:(prefix+p.basis+' Ordinary waste included; supply/labour coverage must be reviewed. '+l.note).slice(0,4000)}:l})
 const addedScopes=new Set<string>()
 for(const [i,item] of raw.additional.entries()){
  const template=scopeTemplates.find(s=>s[0]===item?.scope),decision=w.scopeReview?.items.find(s=>s.key===item?.scope)
  if(!template||addedScopes.has(item.scope)||!text(item.name,200)||!text(item.basis,1500)||!price(item.cost)||item.cost<=0||decision?.status==='excluded'||lines.some(l=>l.included&&l.packagePart==='provisional-scope:'+item.scope)||decision?.lineIds.some(id=>lines.some(l=>l.id===id&&l.included)))throw new Error('An allowance overlaps linked or excluded scope. Your estimate has not changed.')
  addedScopes.add(item.scope)
  const id='provisional-'+globalThis.crypto.randomUUID()
  lines.push({id,trade:template[1],name:item.name,unit:'item',source:'entered',quantity:1,rate:item.cost,labour:0,waste:0,included:true,allowance:true,rateVerified:false,quantityVerified:false,packagePart:'provisional-scope:'+item.scope,note:prefix+item.basis})
 }
 if(lines.length>500)throw new Error('This draft has too many scope items.')
 const qualification='PROVISIONAL PRICING FOR WORKFLOW TRIAL — not an approved quote. '+raw.assumptions.join(' ')
 const project=revise(w.project,{lines,exclusions:(w.project.working.exclusions+'\n'+qualification).slice(0,8000)})
 if(totals(project.working).cost<=0||totals(project.working).cost>1e9)throw new Error('The draft total is outside supported limits.')
 return {...w,project}
}
export function pricingContext(w:Workspace){return {
 name:w.name,location:w.address,projectKind:w.scopeReview?.kind||'unknown',date:new Date().toISOString().slice(0,10),
 groups:pricingGroups(w),existing:w.project.working.lines.map(l=>({name:l.name,trade:l.trade,unit:l.unit,quantity:quantity(l,w.project.working.design),included:l.included,priced:l.rate+(l.labour||0)>0,scope:l.packagePart?.startsWith('provisional-scope:')?l.packagePart.slice(18):undefined,note:l.note})),
 scope:w.scopeReview,readings:w.documentReadings?.map(d=>({name:d.name,summary:d.summary,items:d.items,questions:d.questions,warnings:d.warnings})),
 sheets:[w.plan,...(w.drawings||[])].filter(Boolean).map(p=>({name:p!.name,page:p!.page,role:p!.role,text:p!.text})),exclusions:w.project.working.exclusions
}}

