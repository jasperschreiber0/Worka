import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { intelligenceDB, allRows } from '@/lib/profitability-data'
import { dateOnly } from '@/lib/profit-control'
export async function GET(_: NextRequest,{params}:{params:{jobId:string}}){
 const builder=await getAuthenticatedBuilderId();if(!builder)return NextResponse.json({error:'Unauthorized'},{status:401})
 if(isDemoMode())return NextResponse.json({error:'Choose a saved job'},{status:400})
 const db=intelligenceDB();const {data:job,error}=await db.from('jobs').select('profitability_revision').eq('id',params.jobId).eq('builder_id',builder).maybeSingle()
 if(error)return NextResponse.json({error:'Unable to load records'},{status:500});if(!job)return NextResponse.json({error:'Job not found'},{status:404})
 try{
 const [costs,hours]=await Promise.all(['job_cost_entries','job_labour_hours'].map(table=>allRows(()=>db.from(table).select('*').eq('job_id',params.jobId).eq('builder_id',builder).order('id'))))
 const latest=await db.from('jobs').select('profitability_revision').eq('id',params.jobId).eq('builder_id',builder).single()
 if(latest.error||latest.data.profitability_revision!==job.profitability_revision)throw new Error('Records changed. Reload before reviewing.')
 return NextResponse.json({costs,hours,revision:job.profitability_revision})
 }catch(e){return NextResponse.json({error:(e as Error).message},{status:409})}
}
export async function POST(req:NextRequest,{params}:{params:{jobId:string}}){
 const builder=await getAuthenticatedBuilderId();if(!builder)return NextResponse.json({error:'Unauthorized'},{status:401})
 if(isDemoMode())return NextResponse.json({error:'Choose a saved job'},{status:400})
 try{
 const b=await req.json();if(!Number.isSafeInteger(b.revision)||b.revision<0)throw new Error('Reload before correcting records')
 if(typeof b.id!=='string'||!['correct_cost','settle_cost','void_cost','correct_hours'].includes(b.action))throw new Error('Choose a record and action')
 if(typeof b.reason!=='string'||b.reason.trim().length<5||b.reason.length>1000)throw new Error('Enter a reason (5–1000 characters)')
 const v=b.values??{}
 if(b.action==='settle_cost'&&!dateOnly(v.incurred_on,'Bill date'))throw new Error('Choose the bill date')
 const {error}=await intelligenceDB().rpc('correct_job_financial_record',{p_builder:builder,p_job:params.jobId,p_revision:b.revision,p_action:b.action,p_id:b.id,p_values:v,p_reason:b.reason.trim()})
 if(error)throw new Error(error.message)
 return NextResponse.json({ok:true})
 }catch(e){return NextResponse.json({error:(e as Error).message},{status:400})}
}
