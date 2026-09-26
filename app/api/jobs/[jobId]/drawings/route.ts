import { NextResponse } from 'next/server'
import { createHash } from 'node:crypto'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { intelligenceDB, allRows } from '@/lib/profitability-data'
import { documentWorkerCount } from '@/lib/estimating/continuation'
export const maxDuration = 60
async function access(jobId:string){const builder=await getAuthenticatedBuilderId();if(!builder)throw Error('Sign in required');const db=intelligenceDB();const {data:job}=await db.from('jobs').select('id,address,status').eq('id',jobId).eq('builder_id',builder).maybeSingle();if(!job)throw Error('Job not found');return {builder,db,job}}
export async function GET(_req:Request,{params}:{params:{jobId:string}}){try{
 const {builder,db,job}=await access(params.jobId)
 const [files,facts,runs]=await Promise.all([
 allRows(()=>db.from('files').select('id,filename,drawing_state,replaces_file_id,duplicate_of_file_id,content_hash,intake_status,created_at,quote_id').eq('job_id',job.id).eq('builder_id',builder).order('created_at')),
 allRows(()=>db.from('project_facts').select('id,key,value,review_required,evidence').eq('job_id',job.id).eq('category','builder_answer').eq('superseded',false).order('created_at')),
 allRows(()=>db.from('estimate_source_sets').select('*').eq('job_id',job.id).eq('builder_id',builder).order('created_at',{ascending:false}))])
 const runIds=runs.map(r=>r.draft_quote_id).filter(Boolean)
 const items=runIds.length?await allRows(()=>db.from('quote_line_items').select('quote_id,trade_category_id,total,description,pricing_source,assumption_status,variation_id').in('quote_id',runIds).order('id')):[]
 return NextResponse.json({job:{...job,builder_id:builder},files,facts,runs:runs.map(r=>({...r,items:items.filter(i=>i.quote_id===r.draft_quote_id)}))})
}catch(e){return NextResponse.json({error:(e as Error).message},{status:(e as Error).message.startsWith('Sign in')?401:(e as Error).message==='Job not found'?404:400})}}
export async function POST(req:Request,{params}:{params:{jobId:string}}){try{
 const {builder,db,job}=await access(params.jobId), body=await req.json()
 if(body.action==='finalise'){
  const {data:file}=await db.from('files').select('*').eq('id',body.file_id).eq('job_id',job.id).eq('builder_id',builder).single();if(!file)throw Error('File not found')
  if(file.drawing_state!=='unresolved')return NextResponse.json({file})
  const {data:blob,error}=await db.storage.from('plans').download(file.storage_path);if(error||!blob)throw Error('Upload is incomplete. Retry the upload; your existing plans are unchanged.')
  if(blob.size>52428800)throw Error('File exceeds 50 MB')
  const hash=createHash('sha256').update(Buffer.from(await blob.arrayBuffer())).digest('hex')
  const {data:verified,error:save}=await db.rpc('finalise_job_upload',{p_builder:builder,p_job:job.id,p_file:file.id,p_hash:hash,p_size:blob.size});if(save)throw Error('Could not record upload verification. Retry.')
  return NextResponse.json({verified:true,file:verified})
 }
 if(body.action==='reconcile'){
  const r=await db.rpc('reconcile_job_drawing',{p_builder:builder,p_job:job.id,p_file:body.file_id,p_action:body.relationship,p_replaces:body.replaces??null});if(r.error)throw Error(r.error.message);return NextResponse.json({saved:true})
 }
 if(body.action==='answer'){
  if(typeof body.answer!=='string'||!body.answer.trim()||body.answer.length>8000)throw Error('Enter a confirmed answer')
  const r=await db.rpc('confirm_job_answer',{p_builder:builder,p_job:job.id,p_fact:body.fact_id??null,p_question:body.question??'',p_answer:body.answer,p_evidence:body.evidence??'Builder reviewed this answer against current drawings'});if(r.error)throw Error(r.error.message);return NextResponse.json({saved:true})
 }
 if(body.action==='refresh'){
  const r=await db.rpc('prepare_estimate_refresh',{p_builder:builder,p_job:job.id,p_request:body.request_id,p_manual:body.manual_policy});if(r.error)throw Error(r.error.message)
  const run=r.data
  await Promise.all(Array.from({length:documentWorkerCount(run.file_ids.length)},async()=>{try{await fetch(process.env.NEXT_PUBLIC_SUPABASE_URL+'/functions/v1/document-worker',{method:'POST',headers:{Authorization:'Bearer '+process.env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'},body:JSON.stringify({parent_job_id:run.batch_id,builder_id:builder}),signal:AbortSignal.timeout(10000)})}catch{/* Saved workflow owns retry. */}}))
  return NextResponse.json({run},{status:202})
 }
 if(body.action==='clear'){
  if(body.confirmed!==true)throw Error('Confirm clearing the selected draft')
  const r=await db.rpc('clear_generated_estimate',{p_builder:builder,p_job:job.id,p_quote:body.quote_id});if(r.error)throw Error(r.error.message);return NextResponse.json({saved:true})
 }
 throw Error('Choose a drawing action')
}catch(e){return NextResponse.json({error:(e as Error).message},{status:(e as Error).message.startsWith('Sign in')?401:(e as Error).message==='Job not found'?404:400})}}
