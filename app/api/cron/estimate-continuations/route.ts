import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
export const dynamic='force-dynamic'
export async function GET(req:NextRequest) {
 const secret=process.env.CRON_SECRET
 if(!secret || req.headers.get('authorization')!==`Bearer ${secret}`) return NextResponse.json({error:'Unauthorized'},{status:401})
 const url=process.env.NEXT_PUBLIC_SUPABASE_URL!, key=process.env.SUPABASE_SERVICE_ROLE_KEY!
 const db=createClient(url,key)
 const {data,error}=await db.rpc('claim_estimate_continuations')
 if(error) return NextResponse.json({error:'Unable to claim queued estimates'},{status:503})
 const results=await Promise.all((data??[]).map(async (row:{batch_id:string;builder_id:string})=>{
  const {data:documents,error:documentsError}=await db.from('document_processing_jobs').select('status').eq('parent_job_id',row.batch_id)
  if(documentsError)return {batch_id:row.batch_id,accepted:false}
  const worker=documents?.some(d=>!['completed','failed'].includes(d.status))?'document-worker':'smooth-responder'
  try {const res=await fetch(`${url}/functions/v1/${worker}`,{method:'POST',headers:{Authorization:`Bearer ${key}`,'Content-Type':'application/json'},body:JSON.stringify({parent_job_id:row.batch_id,builder_id:row.builder_id}),signal:AbortSignal.timeout(10000)})
   return {batch_id:row.batch_id,accepted:res.ok,status:res.status}
  } catch {return {batch_id:row.batch_id,accepted:false}}
 }))
 return NextResponse.json({results})
}
