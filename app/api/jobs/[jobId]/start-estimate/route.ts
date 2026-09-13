import {NextResponse} from 'next/server'
import {createClient} from '@supabase/supabase-js'
import {getAuthenticatedBuilderId,isDemoMode} from '@/lib/auth/api-auth'
export async function POST(req:Request,{params}:{params:{jobId:string}}){
 const builderId=await getAuthenticatedBuilderId();if(!builderId)return NextResponse.json({error:'Unauthorized'},{status:401});if(isDemoMode())return NextResponse.json({demo:true})
 let body;try{body=await req.json()}catch{return NextResponse.json({error:'Invalid upload request'},{status:400})}
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL!,key=process.env.SUPABASE_SERVICE_ROLE_KEY!,db=createClient(url,key)
 const {data:batchId,error}=await db.rpc('start_estimate_upload',{p_builder_id:builderId,p_job_id:params.jobId,p_upload_batch_id:body.upload_batch_id,p_files:body.file_ids})
 if(error)return NextResponse.json({error:error.message},{status:400})
 // Durable queue is saved before replying. A lost initial dispatch is recovered by cron.
 try{const dispatch=await fetch(url+'/functions/v1/document-worker',{method:'POST',headers:{Authorization:'Bearer '+key,'Content-Type':'application/json'},body:JSON.stringify({parent_job_id:batchId,builder_id:builderId}),signal:AbortSignal.timeout(10000)});if(!dispatch.ok)console.error('estimate_dispatch_rejected',{batch_id:batchId,status:dispatch.status})}catch{console.error('estimate_dispatch_unavailable',{batch_id:batchId})}
 return NextResponse.json({batch_id:batchId,queued:true},{status:202})
}
