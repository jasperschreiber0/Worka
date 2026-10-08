import type {DocumentReading} from './studio-document-reading.ts'
import type {PlanSource} from './studio-workspace.ts'

/** Estimating needs existing work, roofs and visual specifications as well as floors. */
export function estimatingPageSelection(reading:DocumentReading){
 const model=modelPageSelection(reading)
 const candidates=reading.sheets.filter(s=>/floor|roof|elevation|section|render|concept design|schedule|existing/i.test(s.role+' '+s.title)&&!/reference images|cover|title page/i.test(s.title))
 const pages=[...model.pages,...candidates.filter(s=>!model.pages.some(p=>p.page===s.page)).map(s=>({...s,role:(/existing|roof|render/i.test(s.title)?'other':/elevation/i.test(s.role+' '+s.title)?'elevation':'other') as PlanSource['role']}))].slice(0,8)
 return {pages,omitted:reading.sheets.filter(s=>!pages.some(p=>p.page===s.page)).map(s=>`Page ${s.page}: ${s.title}`)}
}

export function modelPageSelection(reading:DocumentReading){
 const sheets=reading.sheets.filter((s,i,a)=>a.findIndex(p=>p.page===s.page)===i)
 if(/electrical|structural|pantry|kitchen elevation|fittings|finishes/i.test(reading.name))return {pages:[],omitted:[]}
 const floors=sheets.filter(s=>/floor[\s_-]*plan/i.test(s.role+' '+s.title)&&!/existing|demolition|roof|reflected|ceiling|electrical|framing|slab/i.test(s.role+' '+s.title))
 if(!floors.length)return {pages:[],omitted:[]}
 const support=sheets.filter(s=>/section/i.test(s.role+' '+s.title)&&!floors.some(f=>f.page===s.page))
 const openings=sheets.filter(s=>/window|door/i.test(s.title)&&/schedule/i.test(s.role+' '+s.title))
 const dimensions=sheets.filter(s=>/wall.*(?:location|layout).*plan|set[ -]?out.*plan/i.test(s.title)&&!floors.some(f=>f.page===s.page))
 const pages=[...floors.slice(0,5).map(s=>({...s,role:'floor-plan' as const})),...dimensions.slice(0,2).map(s=>({...s,role:'other' as const})),...support.slice(0,1).map(s=>({...s,role:'section' as const})),...openings.slice(0,2).map(s=>({...s,role:'other' as const}))].slice(0,8)
 const omitted=sheets.filter(s=>!pages.some(p=>p.page===s.page)).map(s=>`Page ${s.page}: ${s.title}`)
 return {pages,omitted}
}

// Retain prior pages and never overwrite a builder's calibration on re-upload.
export function appendModelPages(existing:PlanSource[],incoming:PlanSource[]){
 const pages=[...existing],skipped:string[]=[]
 for(const page of incoming){
  if(pages.some(p=>p.name===page.name&&p.page===page.page)){skipped.push(`${page.name} page ${page.page}: existing saved page retained`);continue}
  if(pages.length>=8||pages.reduce((n,p)=>n+p.image.length,0)+page.image.length>8000000){skipped.push(`${page.name} page ${page.page}: drawing storage limit reached`);continue}
  pages.push(page)
 }
 return {pages,skipped}
}
