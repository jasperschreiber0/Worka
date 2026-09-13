import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
export async function POST(req: NextRequest, { params }: { params: { jobId: string; questionId: string } }) {
 const builderId = await getAuthenticatedBuilderId()
 if (!builderId) return NextResponse.json({error:'Unauthorized'}, {status:401})
 if (isDemoMode()) return NextResponse.json({error:'Answers cannot be saved in demo mode'}, {status:400})
 let body
 try { body = await req.json() } catch { return NextResponse.json({error:'Invalid answer'}, {status:400}) }
 if (typeof body?.answer !== 'string' || !body.answer.trim() || body.answer.trim().length > 4000) return NextResponse.json({error:'Enter an answer of up to 4,000 characters'}, {status:400})
 try {
 const { createClient } = await import('@supabase/supabase-js')
 const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
 const {data:job,error:jobError} = await sb.from('jobs').select('id').eq('id',params.jobId).eq('builder_id',builderId).maybeSingle()
 if(jobError) throw jobError
 if(!job) return NextResponse.json({error:'Job not found'}, {status:404})
 const answer=body.answer.trim()
 const {data:reviewId,error}=await sb.rpc('save_estimate_answer',{p_builder_id:builderId,p_job_id:params.jobId,p_question_id:params.questionId,p_answer:answer,p_previous:body.previous_answer??null})
 if(error)return NextResponse.json({error:error.message},{status:error.code==='40001'?409:422})
 const {data:review}=await sb.from('assumptions').select('id,quote_id,resolution_type').eq('id',reviewId).maybeSingle()
 return NextResponse.json({saved:true,estimate_updated:false,review})
 } catch { return NextResponse.json({error:'Could not save your answer. Please try again.'},{status:500}) }
}
