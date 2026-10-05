import type {PlanSource} from './studio-workspace.ts'

export type IndexedSheet={page:number;title:string;role:NonNullable<PlanSource['role']>;purpose:'floor'|'walls'|'setout'|'openings'|'section'|'elevation'|'other';recommended:boolean}
/** Prefer the sheet title block. A cover's drawing register is not a floor plan. */
export function identifySheet(page:number,text:string):IndexedSheet{
 const normalized=text.replace(/\s+/g,' ').trim()
 const block=normalized.lastIndexOf('PROJECT PROJECT NUMBER')
 const titleText=block>=0?normalized.slice(block):normalized
 const cover=/\b(?:cover|drawing (?:register|index)|site location)\b/i.test(titleText)||new Set(titleText.match(/\bCD-\d{3}\b/g)||[]).size>3
 const patterns:[IndexedSheet['purpose'],RegExp,IndexedSheet['role']][]=[
  ['other',/\b(?:existing|demolition|reflected ceiling|roof|waste management|site)\s+(?:floor\s+)?plan\b/i,'other'],
  ['walls',/\bwall\s+(?:location|layout|types?)\s+plan(?:\s+GF)?\b/i,'other'],
  ['setout',/\bset[ -]?out\s+plan\b/i,'other'],
  ['openings',/\b(?:window(?:s)?(?:\s*(?:&|and|\/)\s*doors?)?|doors?)\s+schedule\b/i,'other'],
  ['floor',/\b(?:(?:proposed|prop\.|ground|first|second|lower|upper|basement)\s+)*floor[ -]plan\b/i,'floor-plan'],
  ['section',/\bsections?(?:\s+sheet)?(?:\s+[\dA-Z]+)?\b/i,'section'],
  ['elevation',/\belevations?(?:\s+sheet)?(?:\s+[\dA-Z]+)?\b/i,'elevation'],
 ]
 const found=cover?undefined:patterns.map(([purpose,pattern,role])=>({purpose,role,match:titleText.match(pattern)})).find(x=>x.match)
 return {page,title:cover?'Cover / drawing index':found?.match?.[0]||'Unidentified sheet — check preview',role:found?.role||'other',purpose:found?.purpose||'other',recommended:!!found&&found.purpose!=='other'}
}
export function recommendedSheets(sheets:IndexedSheet[]){
 // Review all pages; the model request remains bounded independently of the library.
 return [...sheets.filter(s=>s.purpose==='floor'),...sheets.filter(s=>['walls','setout','openings'].includes(s.purpose)),...sheets.filter(s=>s.purpose==='section').slice(0,1),...sheets.filter(s=>s.purpose==='elevation').slice(0,1)].map(s=>s.page)
}
export function floorSupportingPages(plan:PlanSource,drawings:PlanSource[]=[]){
 return drawings.filter(p=>p.name===plan.name&&p.page!==plan.page&&p.role!=='floor-plan').slice(0,7)
}

export function stageSupportingPages(pages:PlanSource[],phase:string){
 const kind=(p:PlanSource)=>identifySheet(p.page,(p.text||[]).map(t=>t.text).join(' ')).purpose
 const priority=phase==='structure'?['setout','walls']:phase==='details'?['openings']:['section','elevation','setout','walls']
 return pages.map(p=>({p,rank:priority.indexOf(kind(p))})).filter(x=>x.rank>=0).sort((a,b)=>a.rank-b.rank).slice(0,2).map(x=>x.p)
}
