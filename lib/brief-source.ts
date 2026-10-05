import type {SupabaseClient} from '@supabase/supabase-js'
import {action,studioAction,testJob,briefItemLabel} from './brief-actions.ts'
import type {BriefAction,BriefWorkspace} from './brief-actions.ts'

// All service-role reads are scoped to the builder resolved by the scheduler.
// Page through results: silently dropping jobs at the API's row cap is unsafe.
async function pages(query:(from:number,to:number)=>PromiseLike<{data:any[]|null;error:unknown}>){
  const rows:any[]=[]
  for(let from=0;from<10000;from+=100){const {data,error}=await query(from,from+99);if(error)throw error;rows.push(...data||[]);if((data||[]).length<100)return rows}
  throw new Error('Morning brief source exceeds the supported batch size')
}
export async function loadBriefActions(db:SupabaseClient,builderId:string,now:Date):Promise<BriefAction[]>{
  const today=new Intl.DateTimeFormat('en-CA',{timeZone:'Australia/Sydney',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
  const [jobs,quotes,invoices,variations,studios]=await Promise.all([
    pages((a,b)=>db.from('jobs').select('id,address,status').eq('builder_id',builderId).order('id').range(a,b)),
    pages((a,b)=>db.from('quotes').select('id,job_id,status,sent_at,quote_line_items(id,description,total,is_assumption,assumption_status,rate,quantity)').eq('builder_id',builderId).eq('is_current',true).in('status',['draft','pending_review','sent']).order('id').range(a,b)),
    pages((a,b)=>db.from('invoices').select('id,job_id,amount,status,due_date').eq('builder_id',builderId).in('status',['sent','overdue']).not('due_date','is',null).lte('due_date',today).order('id').range(a,b)),
    pages((a,b)=>db.from('variations').select('id,job_id,title,amount,status').eq('builder_id',builderId).eq('status','pending').order('id').range(a,b)),
    // Select current fields only, not image data, recovery history or old options.
    pages((a,b)=>db.from('studio_workspaces').select('id,name,address:document->workspace->>address,demo:document->workspace->demo,project:document->workspace->project,scopeReview:document->workspace->scopeReview,cashTiming:document->workspace->cashTiming,planName:document->workspace->plan->>name').eq('owner_id',builderId).order('id').range(a,b)),
  ])
  return assembleBriefActions({jobs,quotes,invoices,variations,studios},now,today)
}
export function assembleBriefActions(data:{jobs:any[];quotes:any[];invoices:any[];variations:any[];studios:BriefWorkspace[]},now:Date,today:string):BriefAction[]{
  const jobs=new Map(data.jobs.filter(j=>!['archived','complete','completed','cancelled'].includes(j.status)&&!testJob(j.address)).map(j=>[j.id,j]))
  const out:BriefAction[]=[]
  const add=(row:any,kind:string,priority:'high'|'medium',message:string,label:string,href:string,state:unknown)=>{
    const j=jobs.get(row.job_id);if(!j)return
    out.push(action({key:`${kind}:${row.id}`,jobKey:`job:${j.id}`,jobName:j.address,priority,message,action:label,href,entity_type:kind},state))
  }
  for(const i of data.invoices){
    if(!i.due_date||i.due_date>today)continue
    const overdue=i.due_date<today,amount=Number(i.amount).toLocaleString('en-AU',{style:'currency',currency:'AUD'})
    add(i,'invoice','high',`Check payment for the ${amount} invoice ${overdue?'overdue in your saved records':'due today'}.`,'Check invoice',`/jobs/${i.job_id}?section=money`,[i.id,i.amount,i.status,i.due_date,overdue])
  }
  for(const v of data.variations)add(v,'variation','high',`Review “${v.title}” and confirm its approval status.`,'Review variation',`/variations/${v.id}/review`,[v.id,v.title,v.amount,v.status])
  for(const q of data.quotes){
    if(q.status==='sent'){
      if(q.sent_at&&now.getTime()-Date.parse(q.sent_at)>=7*86400000)add(q,'quote','medium','Check whether the client has responded to the estimate sent last week or earlier.','Review follow-up',`/jobs/${q.job_id}?estimate=1`,[q.id,q.sent_at,q.status])
      continue
    }
    const lines=(q.quote_line_items||[]).filter((i:any)=>i.assumption_status!=='excluded').sort((a:any,b:any)=>a.description.localeCompare(b.description)||a.id.localeCompare(b.id))
    const price=lines.find((i:any)=>i.total===null||Number(i.rate)<=0),scope=lines.find((i:any)=>i.is_assumption&&i.assumption_status==='unresolved')
    const message=price?`Confirm the price for ${briefItemLabel(price.description)}.`:scope?`Confirm what is included for ${briefItemLabel(scope.description)}.`:'Check the scope, allowances and exclusions before issuing this estimate.'
    add(q,'quote','medium',message,price?'Review costs':scope?'Confirm scope':'Review estimate',`/jobs/${q.job_id}?estimate=1`,[q.status,lines])
  }
  for(const w of data.studios){const next=studioAction(w);if(next)out.push(next)}
  return out
}
