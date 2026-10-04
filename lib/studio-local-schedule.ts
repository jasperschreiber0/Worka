import {parseDocumentReading} from './studio-document-reading.ts'
import type {SourcePage} from './studio-document-reading.ts'
/** Deterministic reader for labelled designer schedules. No network, OCR or inferred trade pricing. */
export function localScheduleReading(source:{id:string;name:string;pages:SourcePage[]}){
 const items:any[]=[],questions:string[]=[],warnings:string[]=[]
 const amount=(s:string|undefined)=>s&&/^\$[\d,]+(?:\.\d{2})?$/.test(s)?Number(s.replace(/[$,]/g,'')):null
 for(const p of source.pages){
  const lines=p.text.split('\n').map(s=>s.trim()).filter(Boolean)
  let start=0
  for(let end=0;end<lines.length;end++){
   if(lines[end]!=='Supplier Email')continue
   let segment=lines.slice(start,end+1);start=end+1
   const tax=segment.lastIndexOf('tax');if(tax>=0)segment=segment.slice(tax+1)
   const product=segment.indexOf('Product Name'),unitAt=segment.indexOf('Client Unit'),totalAt=segment.indexOf('Client Total')
   if(product<1||unitAt<product||totalAt<unitAt)continue
   const header=segment.slice(0,product),title=header[0],location=header[1]||'',optional=/option|alternative/i.test(header.join(' '))
   const unitPrice=amount(segment[unitAt-1]),total=amount(segment[totalAt-1])
   const ratio=unitPrice&&total?total/unitPrice:null
   const quantity=!optional&&ratio!==null&&ratio>0&&Math.abs(ratio-Math.round(ratio))<.00001?Math.round(ratio):null
   const name=(title+' — '+location).slice(0,280)
   const evidence=[{page:p.page,quote:header.join(' ').slice(0,650)}]
   // Add the entire small price block: this quote includes numbers and their labels in source order.
   evidence.push({page:p.page,quote:segment.slice(Math.max(product+1,unitAt-1),totalAt+1).join(' ')})
   items.push({scope:/materials|finishes/i.test(source.name)?'finishes':'fixtures',name:(optional?'Alternative: ':'')+name,unit:'priced unit',quantity,basis:optional?'Alternative selection: not included in quantity until selected.':quantity!==null?`Schedule arithmetic: client total $${total} ÷ client unit $${unitPrice} = ${quantity} priced units. Confirm physical unit and quantity against the plans; not a measured takeoff.`:'No usable positive quantity established by the schedule; measure or confirm it.',evidence,price:unitPrice,tax:'unknown',priceBasis:`Printed client unit price${total!==null?`; printed client total $${total}`:''}. Supply allowance only. Freight, installation, discounts and GST treatment unconfirmed.`})
  }
 }
 if(items.length){questions.push('Are these draft selections current, and which alternatives should be used?','Do the printed client unit prices include GST, and are they builder supply costs or retail allowances?','Which items are client-supplied, and what freight and installation costs apply?','Confirm physical units and quantities: price ratios are not measured drawing quantities.');warnings.push('Read locally from labelled PDF text only. No geometric measurement or external AI processing.','Zero schedule totals are not free work: they leave quantities unresolved.','Prices with unknown GST treatment are not applied to the estimate.','Alternative rows retain unknown quantities until selections are confirmed.')}
 else warnings.push('Local text reading did not find a supported priced schedule. Visual plan interpretation is still required; no geometry or quantities inferred.')
 if(items.length>100)warnings.push(`${items.length-100} further items omitted because this reading is limited to 100 items. Split the schedule before continuing.`)
 const date=source.pages.map(p=>p.text).join(' ').match(/\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b/)?.[0]||''
 return parseDocumentReading({revision:`Draft schedule ${date}`.trim(),summary:`Local text extraction: ${Math.min(items.length,100)} candidate schedule items. Printed prices are retained separately from the draft estimate; no missing trade prices were invented.`,items:items.slice(0,100),questions,warnings,sheets:source.pages.map(p=>({page:p.page,role:'schedule / source page',title:p.text.split('\n').find(s=>s.trim())?.slice(0,300)||'Image-only or unreadable text'}))},source)
}
