import {NextResponse} from 'next/server'
import {getAuthenticatedBuilderId,isDemoMode} from '@/lib/auth/api-auth'
import {allRows,intelligenceDB} from '@/lib/profitability-data'
import {programmeReadiness,type WorkflowRecord} from '@/lib/job-workflow'
export const dynamic='force-dynamic'
export async function GET(){
 const builder=await getAuthenticatedBuilderId();if(!builder)return NextResponse.json({error:'Sign in required'},{status:401})
 if(isDemoMode())return NextResponse.json({items:[],coverage:'Connect a real job to see recorded work. No live balances are available.'})
 try{
 const db=intelligenceDB(),today=new Date().toLocaleDateString('en-CA',{timeZone:'Australia/Sydney'})
 const [jobs,records,variations,quotes,invoices]=await Promise.all([
 allRows(()=>db.from('jobs').select('id,address,status').eq('builder_id',builder).not('status','in','(archived,complete)').order('id')),
 allRows(()=>db.from('job_workflow_records').select('*').eq('builder_id',builder).order('created_at')),
 allRows(()=>db.from('variations').select('id,job_id,title,amount,status').eq('builder_id',builder).in('status',['draft','pending']).order('created_at')),
 allRows(()=>db.from('quotes').select('id,job_id,status,created_at').eq('builder_id',builder).in('status',['draft','pending_review','sent']).order('created_at')),
 allRows(()=>db.from('invoices').select('id,job_id,description,amount,status,due_date').eq('builder_id',builder).in('status',['sent','overdue']).order('id'))])
 const names=new Map(jobs.map(j=>[j.id,j.address])),items:any[]=[]
 for(const r of records as WorkflowRecord[]){if(!names.has(r.job_id)||['completed','superseded'].includes(r.status))continue;const p=r.payload;const readiness=r.kind==='programme'?programmeReadiness(r,records,today):null
 if(r.kind==='programme'&&p.start_on>today)continue
 if(['purchase_order','trade_quote'].includes(r.kind)&&(!p.due_on||p.due_on>today))continue
 items.push({id:r.id,job:names.get(r.job_id),title:r.title,kind:r.kind,status:r.status,due:p.due_on??p.start_on??null,owner:p.owner??null,blockers:readiness?.blockers??[],amount:r.kind==='bill'?p.net_amount:null,href:`/jobs/${r.job_id}/workflow#${r.id}`})}
 for(const v of variations){if(names.has(v.job_id))items.push({id:v.id,job:names.get(v.job_id),title:v.title,kind:'unsigned_variation',status:v.status,amount:v.amount,href:`/variations/${v.id}/review`})}
 for(const q of quotes){if(names.has(q.job_id))items.push({id:q.id,job:names.get(q.job_id),title:q.status==='sent'?'Follow up issued quote':'Review estimate draft',kind:'quote',status:q.status,href:`/jobs/${q.job_id}`})}
 for(const i of invoices){if(names.has(i.job_id))items.push({id:i.id,job:names.get(i.job_id),title:i.description||'Client invoice',kind:'client_invoice',status:i.status,due:i.due_date,amount:i.amount,href:`/jobs/${i.job_id}?section=money`})}
 items.sort((a,b)=>String(a.due??'9999').localeCompare(String(b.due??'9999')))
 return NextResponse.json({today,items,coverage:'Recorded job actions only. Bill amounts are not verified unpaid bank balances. Programme dates are proposed unless separately confirmed. Missing inputs mean incomplete coverage.'})
 }catch{return NextResponse.json({error:'Could not load daily actions. Retry before relying on this list.'},{status:503})}
}
