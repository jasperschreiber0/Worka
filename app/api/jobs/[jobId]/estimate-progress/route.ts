import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId,isDemoMode } from '@/lib/auth/api-auth'
export const dynamic='force-dynamic'
async function context(jobId:string) {
 const builderId=await getAuthenticatedBuilderId()
 if(!builderId || isDemoMode()) return null
 const db=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!,process.env.SUPABASE_SERVICE_ROLE_KEY!)
 const {data:job}=await db.from('jobs').select('id').eq('id',jobId).eq('builder_id',builderId).maybeSingle()
 if(!job) return null
 const {data:batch}=await db.from('document_processing_batches').select('id,quote_id,total_ai_call_attempts,stage6_completed_trade_ids').eq('job_id',jobId).eq('builder_id',builderId).order('created_at',{ascending:false}).limit(1).maybeSingle()
 return {db,builderId,batch}
}
export async function GET(_req:NextRequest,{params}:{params:{jobId:string}}) {
 const c=await context(params.jobId);if(!c) return NextResponse.json({error:'Job not found'},{status:404})
 if(!c.batch) return NextResponse.json({workflow:null})
 const {data:workflow,error}=await c.db.from('estimate_workflow').select('state,reason,attempt_limit,cost_limit_cents').eq('batch_id',c.batch.id).eq('builder_id',c.builderId).maybeSingle()
 if(error) return NextResponse.json({error:'Progress unavailable'},{status:503})
 return NextResponse.json({workflow,attempts:c.batch.total_ai_call_attempts,completed_trades:c.batch.stage6_completed_trade_ids?.length??0,quote_id:c.batch.quote_id})
}
export async function POST(req:NextRequest,{params}:{params:{jobId:string}}) {
 const c=await context(params.jobId);if(!c?.batch) return NextResponse.json({error:'Estimate not found'},{status:404})
 let body;try{body=await req.json()}catch{return NextResponse.json({error:'Invalid request'},{status:400})}
 const {data,error}=await c.db.rpc('resume_estimate_workflow',{p_batch_id:c.batch.id,p_builder_id:c.builderId,p_extend:body.extend===true})
 if(error) return NextResponse.json({error:error.message},{status:409})
 return NextResponse.json(data)
}
