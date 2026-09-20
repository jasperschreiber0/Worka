import { NextRequest,NextResponse } from 'next/server'
import { getAuthenticatedBuilderId,isDemoMode } from '@/lib/auth/api-auth'
import { intelligenceDB } from '@/lib/profitability-data'
import { dateOnly } from '@/lib/profit-control'
export async function POST(req:NextRequest){
  const builder=await getAuthenticatedBuilderId()
  if(!builder)return NextResponse.json({error:'Unauthorized'},{status:401})
  if(isDemoMode())return NextResponse.json({error:'Connect your account to save evidence'},{status:400})
  try {
    const b=await req.json()
    if(!['licence','insurance','SWMS','classification review'].includes(b.kind))throw new Error('Choose a document type')
    if(typeof b.evidence!=='string'||!b.evidence.trim()||b.evidence.length>2000)throw new Error('Enter an evidence reference of 1–2,000 characters')
    if(b.confirmed!==true)throw new Error('Confirm that you reviewed this evidence')
    const r=await intelligenceDB().rpc('record_worker_compliance',{p_builder:builder,p_worker:b.worker_id,p_kind:b.kind,p_evidence:b.evidence.trim(),p_expires:dateOnly(b.expires_on,'Expiry')})
    if(r.error)throw r.error
    return NextResponse.json({ok:true})
  }catch(e){return NextResponse.json({error:(e as Error).message},{status:400})}
}
