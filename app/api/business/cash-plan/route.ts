import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { intelligenceDB } from '@/lib/profitability-data'
import { EMPTY_PROFILE } from '@/lib/profitability'
import { projectCash, validateCashPlan } from '@/lib/cash-plan'
export async function GET() {
  const builder=await getAuthenticatedBuilderId()
  if(!builder) return NextResponse.json({error:'Unauthorized'},{status:401})
  if(isDemoMode()) return NextResponse.json({plan:null,legacy:null,revision:null,demo:true})
  const {data,error}=await intelligenceDB().from('business_financial_profiles').select('cash_flow,updated_at').eq('builder_id',builder).maybeSingle()
  if(error) return NextResponse.json({error:'Unable to load the cash plan'},{status:500})
  return NextResponse.json({plan:data?.cash_flow?.plan??null,legacy:data?.cash_flow??null,revision:data?.updated_at??null})
}
export async function PUT(req: NextRequest) {
  const builder=await getAuthenticatedBuilderId()
  if(!builder) return NextResponse.json({error:'Unauthorized'},{status:401})
  if(isDemoMode()) return NextResponse.json({error:'Connect your business account to save'},{status:400})
  try {
    const text=await req.text(); if(text.length>2_000_000) throw new Error('Cash plan is too large')
    const body=JSON.parse(text), plan=validateCashPlan(body.plan), projection=projectCash(plan)
    if(body.revision!==null && (typeof body.revision!=='string'||!Number.isFinite(Date.parse(body.revision)))) throw new Error('Reload the cash plan before saving')
    const revision=new Date().toISOString(), db=intelligenceDB()
    const cash_flow={opening:plan.opening,startOn:plan.startOn,complete:plan.complete,weeks:projection.weeks.map(w=>({inflow:w.inflow,outflow:w.outflow})),plan}
    const result=body.revision===null
      ? await db.from('business_financial_profiles').insert({builder_id:builder,profile:EMPTY_PROFILE,cash_flow,updated_at:revision}).select('updated_at').single()
      : await db.from('business_financial_profiles').update({cash_flow,updated_at:revision}).eq('builder_id',builder).eq('updated_at',body.revision).select('updated_at').maybeSingle()
    if(result.error?.code==='23505'||(!result.error&&!result.data)) return NextResponse.json({error:'This forecast changed in another window. Reload before saving; your draft has not been saved.'},{status:409})
    if(result.error) throw new Error('Unable to save cash forecast')
    return NextResponse.json({ok:true,revision:result.data!.updated_at,plan})
  } catch(e) {return NextResponse.json({error:(e as Error).message},{status:400})}
}
