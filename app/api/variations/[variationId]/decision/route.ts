import { NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { intelligenceDB } from '@/lib/profitability-data'
import { requirePermission } from '@/lib/auth/role-guard'
export const dynamic='force-dynamic'
export async function GET(_req:Request,{params}:{params:{variationId:string}}){
 const builder=await getAuthenticatedBuilderId();if(!builder)return NextResponse.json({error:'Sign in required'},{status:401})
 const {data,error}=await intelligenceDB().from('variations').select('id,job_id,title,description,amount,status,issue_stage,approval_evidence').eq('id',params.variationId).eq('builder_id',builder).maybeSingle()
 return data&&!error?NextResponse.json({variation:data}):NextResponse.json({error:'Variation not found'},{status:404})
}
export async function POST(req:Request,{params}:{params:{variationId:string}}){
 const denied=await requirePermission(req as any,'approve_variation');if(denied)return NextResponse.json({error:'Builder approval required'},{status:403})
 const builder=await getAuthenticatedBuilderId();if(!builder)return NextResponse.json({error:'Sign in required'},{status:401})
 try{const b=await req.json();if(!['builder_approved','issued'].includes(b.action))throw Error('Choose approve for issue or record issue')
 const {data,error}=await intelligenceDB().rpc('record_variation_decision',{p_builder:builder,p_id:params.variationId,p_action:b.action,p_date:b.date||null,p_evidence:b.evidence||''});if(error)throw Error(error.message)
 return NextResponse.json({variation:data})
 }catch(e){return NextResponse.json({error:(e as Error).message},{status:400})}
}
