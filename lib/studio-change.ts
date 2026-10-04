import {lineCost,quantity,totals,round} from './project-studio.ts'
import type {Revision,Line} from './project-studio.ts'
export const impactTopics=['Structure and foundations','Demolition and making good','Electrical and plumbing','Roof and weatherproofing','Access, programme and professional fees']
export function scopeSignature(r:Revision){return JSON.stringify({design:r.design,lines:r.lines,markup:r.markup,exclusions:r.exclusions})}
export function impactIssues(from:Revision,to:Revision){
 if(JSON.stringify(from.design)===JSON.stringify(to.design))return []
 return impactTopics.filter(topic=>!to.impactReview?.some(c=>c.topic===topic&&c.signature===scopeSignature(to)&&c.note.trim()&&['included','excluded','unaffected'].includes(c.status))).map(t=>'Review change impact: '+t)
}
export function changeImpact(from:Revision,to:Revision){
 const ids=Array.from(new Set([...from.lines.map(l=>l.id),...to.lines.map(l=>l.id)]))
 const rows=ids.flatMap(id=>{const a=from.lines.find(l=>l.id===id),b=to.lines.find(l=>l.id===id),aq=a?.included?quantity(a,from.design):0,bq=b?.included?quantity(b,to.design):0,ac=a?lineCost(a,from.design):0,bc=b?lineCost(b,to.design):0;
 if(JSON.stringify(a)===JSON.stringify(b)&&aq===bq&&ac===bc)return []
 return [{id,name:b?.name||a!.name,unit:b?.unit||a!.unit,beforeUnit:a?.unit||b!.unit,before:aq,after:bq,costBefore:ac,costAfter:bc,costDelta:round(bc-ac),status:!a?.included&&b?.included?'Added':a?.included&&!b?.included?'Removed':'Changed'}]})
 const a=totals(from),b=totals(to)
 return {rows,before:a,after:b,costDelta:round(b.cost-a.cost),priceDelta:round(b.price-a.price),totalDelta:round(b.total-a.total),designChanged:JSON.stringify(from.design)!==JSON.stringify(to.design),exclusionsChanged:from.exclusions!==to.exclusions,markupChanged:from.markup!==to.markup}
}
export const assemblyTemplates=[{id:'wall',name:'Wall construction',target:'wall',parts:[['Structure','Framing'],['Envelope','Insulation'],['Interiors','Internal lining'],['Interiors','Painting']]},{id:'floor',name:'Room floor finish',target:'room',parts:[['Interiors','Floor preparation'],['Interiors','Floor finish'],['Interiors','Installation sundries']]}] as const
export function packageLines(template:string,targetId:string,label:string,id:()=>string):Line[]{
 const t=assemblyTemplates.find(t=>t.id===template);if(!t||!targetId)throw new Error('Choose a model element.')
 const packageId=id();return t.parts.map(([trade,name])=>({id:id(),packagePart:name,packageId,packageName:t.name,trade,name:label+' · '+name,unit:'m²',quantity:0,rate:0,labour:0,waste:0,source:t.target==='wall'?'wall-area':'room-area',...(t.target==='wall'?{wallId:targetId}:{roomId:targetId}),included:true,allowance:false,rateVerified:false,note:t.target==='wall'?'Net area of one wall face, openings deducted. Confirm framing rules, both sides, fixings and minimum charges.':'Room polygon area. Confirm preparation, waste and minimum charges.'}))
}
