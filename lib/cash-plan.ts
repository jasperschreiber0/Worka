// Cash is bank movement including GST, never earned revenue or job profit.
export type CashEntry = { id: string; label: string; direction: 'in' | 'out'; amount: number; dueOn: string; expectedOn: string; frequency: 'once' | 'weekly' | 'fortnightly' | 'monthly'; endOn: string; note: string; timing: 'day' | 'week' }
export type CashPlan = { version: 1; startOn: string; opening: number; buffer: number; accounts: string; complete: boolean; entries: CashEntry[] }
export const cashDate = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0,10) === value
export const addDays = (value: string, days: number) => new Date(Date.parse(value) + days * 86400000).toISOString().slice(0,10)
const cents = (value: number) => Math.round(value * 100)
export function validateCashPlan(value: unknown): CashPlan {
  const p = value as CashPlan
  if (!p || p.version !== 1 || !cashDate(p.startOn) || typeof p.complete !== 'boolean') throw new Error('Enter a valid forecast start and confirmation')
  if (!Number.isFinite(p.opening) || Math.abs(p.opening) > 1e9 || !Number.isFinite(p.buffer) || p.buffer < 0 || p.buffer > 1e9) throw new Error('Enter valid opening cash and buffer')
  if (typeof p.accounts !== 'string' || !p.accounts.trim() || p.accounts.length > 300) throw new Error('Name the business accounts included in opening cash')
  if (!Array.isArray(p.entries) || p.entries.length > 2000) throw new Error('A cash plan supports up to 2,000 entries')
  const ids = new Set<string>()
  const entries = p.entries.map(e => {
    if (!e || typeof e.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(e.id) || ids.has(e.id)) throw new Error('Cash entries need unique identifiers')
    ids.add(e.id)
    if (typeof e.label !== 'string' || !e.label.trim() || e.label.length > 200 || typeof e.note !== 'string' || e.note.length > 1000) throw new Error('Enter a payment description and a shorter note')
    if (!['in','out'].includes(e.direction) || !Number.isFinite(e.amount) || e.amount <= 0 || e.amount > 1e9) throw new Error('Each payment needs a positive amount and direction')
    if (!cashDate(e.dueOn) || !cashDate(e.expectedOn) || !['once','weekly','fortnightly','monthly'].includes(e.frequency) || !['day','week'].includes(e.timing)) throw new Error('Check payment dates and repeat frequency')
    if (e.frequency !== 'once' && (!cashDate(e.endOn) || e.endOn < e.expectedOn || Date.parse(e.endOn)-Date.parse(e.expectedOn)>3660*86400000)) throw new Error('Repeating payments need an end date within ten years')
    return { id:e.id,label:e.label.trim(),direction:e.direction,amount:cents(e.amount)/100,dueOn:e.dueOn,expectedOn:e.expectedOn,frequency:e.frequency,endOn:e.frequency==='once'?'':e.endOn,note:e.note,timing:e.timing }
  })
  return {version:1,startOn:p.startOn,opening:cents(p.opening)/100,buffer:cents(p.buffer)/100,accounts:p.accounts.trim(),complete:p.complete,entries}
}
function occurrence(e: CashEntry, n: number) {
  if (e.frequency !== 'monthly') return addDays(e.expectedOn,n*(e.frequency==='fortnightly'?14:7))
  const d = new Date(e.expectedOn), day = d.getUTCDate()
  const target = new Date(Date.UTC(d.getUTCFullYear(),d.getUTCMonth()+n,1))
  const last = new Date(Date.UTC(target.getUTCFullYear(),target.getUTCMonth()+1,0)).getUTCDate()
  target.setUTCDate(Math.min(day,last)); return target.toISOString().slice(0,10)
}
export function projectCash(p: CashPlan, scenario?: {id: string; days: number}) {
  const end = addDays(p.startOn,90)
  const movements: (CashEntry & { on: string })[] = []
  for (const e of p.entries) {
    for (let n=0;n<525;n++) {
      const scheduled = occurrence(e,n)
      if ((e.frequency==='once' && n>0) || (e.frequency!=='once' && scheduled>e.endOn)) break
      const on = addDays(scheduled,scenario?.id===e.id && e.direction==='in'?scenario.days:0)
      if (on>end) break
      if (on>=p.startOn) movements.push({...e,on})
    }
  }
  let balance=cents(p.opening), lowest=balance, lowestOn=p.startOn
  const daily=Array.from({length:91},(_,i)=>{
    const on=addDays(p.startOn,i), entries=movements.filter(e=>e.on===on)
    const inflow=entries.filter(e=>e.direction==='in').reduce((s,e)=>s+cents(e.amount),0)
    const outflow=entries.filter(e=>e.direction==='out').reduce((s,e)=>s+cents(e.amount),0)
    balance+=inflow-outflow
    if(balance<lowest){lowest=balance;lowestOn=on}
    return {on,inflow:inflow/100,outflow:outflow/100,closing:balance/100,entries}
  })
  const weeks=Array.from({length:13},(_,i)=>{
    const days=daily.slice(i*7,i*7+7)
    return {startOn:days[0].on,inflow:days.reduce((s,d)=>s+cents(d.inflow),0)/100,outflow:days.reduce((s,d)=>s+cents(d.outflow),0)/100,closing:days[6].closing}
  })
  return {daily,weeks,lowest:lowest/100,lowestOn,headroom:(lowest-cents(p.buffer))/100,weeklyTiming:movements.some(e=>e.timing==='week'),overdue:p.entries.filter(e=>e.frequency==='once' && e.expectedOn<p.startOn)}
}
export function legacyCashPlan(cash: {opening:number;startOn:string;weeks:{inflow:number;outflow:number}[]}): CashPlan {
  return {version:1,startOn:cash.startOn,opening:cash.opening,buffer:0,accounts:'Business accounts — confirm which accounts are included',complete:false,
    entries:cash.weeks.flatMap((w,i)=>(['in','out'] as const).flatMap(direction=>{
      const amount=direction==='in'?w.inflow:w.outflow
      return amount>0?[{id:`weekly-${i}-${direction}`,label:`Week ${i+1} ${direction==='in'?'receipts':'payments'}`,direction,amount,dueOn:addDays(cash.startOn,i*7+6),expectedOn:addDays(cash.startOn,i*7+6),frequency:'once' as const,endOn:'',note:'Imported weekly total. Replace this allowance when adding its detailed payments; do not count both.',timing:'week' as const}]:[]
    }))}
}
