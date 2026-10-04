import {scopeTemplates,newScopeReview} from './studio-scope.ts'
import {revise} from './project-studio.ts'
import type {Workspace} from './studio-workspace.ts'
export type SourcePage={page:number;text:string}
export type Evidence={page:number;quote:string}
export type ExtractedItem={id:string;scope:string;name:string;unit:string;quantity:number|null;basis:string;evidence:Evidence[];price:number|null;tax:'included'|'excluded'|'unknown';priceBasis:string}
export type DocumentReading={id:string;name:string;pages:number;revision:string;summary:string;readAt:string;items:ExtractedItem[];questions:string[];warnings:string[];sheets:{page:number;role:string;title:string}[];applied:string[]}
const text=(v:unknown,n:number)=>typeof v==='string'&&v.length<=n
const normalize=(s:string)=>s.normalize('NFKC').replace(/\s+/g,' ').trim().toLowerCase()
export const documentReadingSchema={type:'object',required:['revision','summary','items','questions','warnings','sheets'],properties:{revision:{type:'string'},summary:{type:'string'},questions:{type:'array',items:{type:'string'}},warnings:{type:'array',items:{type:'string'}},sheets:{type:'array',items:{type:'object',required:['page','role','title'],properties:{page:{type:'integer'},role:{type:'string'},title:{type:'string'}}}},items:{type:'array',maxItems:100,items:{type:'object',required:['scope','name','unit','quantity','basis','evidence','price','tax','priceBasis'],properties:{scope:{type:'string',enum:scopeTemplates.map(t=>t[0])},name:{type:'string'},unit:{type:'string'},quantity:{type:['number','null']},basis:{type:'string'},evidence:{type:'array',items:{type:'object',required:['page','quote'],properties:{page:{type:'integer'},quote:{type:'string'}}}},price:{type:['number','null']},tax:{type:'string',enum:['included','excluded','unknown']},priceBasis:{type:'string'}}}}}}
export function parseDocumentReading(raw:any,source:{id:string;name:string;pages:SourcePage[]}):DocumentReading{
 if(!raw||!Array.isArray(raw.items)||raw.items.length>100||!text(raw.summary,4000)||!text(raw.revision,200)||!Array.isArray(raw.questions)||raw.questions.length>40||!raw.questions.every((s:unknown)=>text(s,1500))||!Array.isArray(raw.warnings)||raw.warnings.length>40||!raw.warnings.every((s:unknown)=>text(s,1500))||!Array.isArray(raw.sheets)||raw.sheets.length>80)throw new Error('The document reading was incomplete. No estimate was changed.')
 const warnings=[...raw.warnings],items:ExtractedItem[]=[]
 for(const [index,item] of raw.items.entries()){
  if(!item||!scopeTemplates.some(t=>t[0]===item.scope)||!text(item.name,300)||!text(item.unit,20)||!text(item.basis,2000)||!text(item.priceBasis,2000)||!['included','excluded','unknown'].includes(item.tax)||![item.quantity,item.price].every(v=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e7))||!Array.isArray(item.evidence)||item.evidence.length<1||item.evidence.length>8)throw new Error('The document reading contained invalid quantities or references.')
  const evidence=item.evidence.filter((e:any)=>Number.isInteger(e?.page)&&text(e.quote,700)&&e.quote.trim().length>=3&&source.pages.some(p=>p.page===e.page&&normalize(p.text).includes(normalize(e.quote))))
  if(evidence.length!==item.evidence.length){warnings.push(`Not imported: ${item.name}. Its quoted evidence could not be matched to the PDF text. Check the drawing visually.`);continue}
  items.push({...item,id:`${source.id}-${index}`,evidence})
 }
 const sheets=raw.sheets.filter((s:any)=>s&&Number.isInteger(s.page)&&source.pages.some(p=>p.page===s.page)&&text(s.role,100)&&text(s.title,300))
 return {id:source.id,name:source.name,pages:source.pages.length,revision:raw.revision,summary:raw.summary,readAt:new Date().toISOString(),items,questions:raw.questions,warnings:warnings.slice(0,140),sheets,applied:[]}
}
export function validDocumentReadings(value:unknown):value is DocumentReading[]{
 if(!Array.isArray(value)||value.length>20)return false
 return new Set(value.map(d=>d?.id)).size===value.length&&value.every(d=>d&&/^[a-f0-9]{64}$/.test(d.id)&&text(d.name,250)&&Number.isInteger(d.pages)&&d.pages>0&&d.pages<=80&&text(d.revision,200)&&text(d.summary,4000)&&Number.isFinite(Date.parse(d.readAt))&&Array.isArray(d.questions)&&d.questions.length<=40&&d.questions.every((s:unknown)=>text(s,1500))&&Array.isArray(d.warnings)&&d.warnings.length<=140&&d.warnings.every((s:unknown)=>text(s,1500))&&Array.isArray(d.sheets)&&d.sheets.length<=80&&d.sheets.every((s:any)=>Number.isInteger(s?.page)&&s.page>0&&s.page<=d.pages&&text(s.role,100)&&text(s.title,300))&&Array.isArray(d.items)&&d.items.length<=100&&new Set(d.items.map((i:any)=>i?.id)).size===d.items.length&&d.items.every((i:any)=>i&&text(i.id,100)&&scopeTemplates.some(t=>t[0]===i.scope)&&text(i.name,300)&&text(i.unit,20)&&text(i.basis,2000)&&text(i.priceBasis,2000)&&['included','excluded','unknown'].includes(i.tax)&&[i.quantity,i.price].every(v=>v===null||(typeof v==='number'&&Number.isFinite(v)&&v>=0&&v<=1e7))&&Array.isArray(i.evidence)&&i.evidence.length>0&&i.evidence.length<=8&&i.evidence.every((e:any)=>Number.isInteger(e?.page)&&e.page>0&&e.page<=d.pages&&text(e.quote,700)))&&Array.isArray(d.applied)&&d.applied.length<=100&&new Set(d.applied).size===d.applied.length&&d.applied.every((id:unknown)=>d.items.some((i:any)=>i.id===id)))
}
export function applyDocumentItems(w:Workspace,documentId:string,itemIds:string[]):Workspace{
 const doc=w.documentReadings?.find(d=>d.id===documentId)
 if(!doc)throw new Error('Read the document first.')
 if(!itemIds.length||new Set(itemIds).size!==itemIds.length||itemIds.some(id=>!doc.items.some(i=>i.id===id)||doc.applied.includes(id)))throw new Error('Select new items; previously imported items cannot be added twice.')
 const items=doc.items.filter(i=>itemIds.includes(i.id));if(w.project.working.lines.length+items.length>500)throw new Error('Estimate item limit reached.')
 const lines=items.map(i=>({id:crypto.randomUUID(),trade:scopeTemplates.find(t=>t[0]===i.scope)![1],name:i.name,unit:i.unit,quantity:i.quantity??0,rate:i.price!==null&&i.tax!=='unknown'?(i.tax==='included'?Math.round(i.price/1.1*100)/100:i.price):0,source:'entered' as const,allowance:true,included:true,quantityVerified:false,rateVerified:false,note:`Document draft, quantity unverified. ${i.basis}\n${doc.name} (${doc.revision})\n${i.evidence.map(e=>`p${e.page}: ${e.quote}`).join('\n')}\nPrinted pricing: ${i.price??'not supplied'}; GST ${i.tax}. ${i.priceBasis}`.slice(0,4000)}))
 const review=structuredClone(w.scopeReview||newScopeReview())
 for(const scope of review.items){const links=items.flatMap((item,index)=>item.scope===scope.key?[lines[index].id]:[]);if(links.length){scope.lineIds=[...scope.lineIds,...links];scope.note=(scope.note+`\nDraft items extracted from ${doc.name}; confirm contracted scope.`).slice(0,2000)}}
 // Extraction is evidence, not authorization: keep included/excluded decisions with the reviewer.
 return {...w,scopeReview:review,project:revise(w.project,{lines:[...w.project.working.lines,...lines]}),documentReadings:w.documentReadings!.map(d=>d.id===documentId?{...d,applied:[...d.applied,...itemIds]}:d)}
}
