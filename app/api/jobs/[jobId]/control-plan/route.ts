import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { intelligenceDB, loadIntelligence } from '@/lib/profitability-data'
import { jobControl, dateOnly } from '@/lib/profit-control'
import { amount } from '@/lib/profitability'
export async function GET(_req: NextRequest,{params}:{params:{jobId:string}}) {
  const builder=await getAuthenticatedBuilderId()
  if(!builder)return NextResponse.json({error:'Unauthorized'},{status:401})
  if(isDemoMode())return NextResponse.json({error:'Connect your account to review real costs'},{status:400})
  try {
    const d=await loadIntelligence(builder,params.jobId), db=intelligenceDB()
    const [p,w]=await Promise.all([db.from('job_control_plans').select('*').eq('job_id',params.jobId).eq('builder_id',builder).maybeSingle(),
      db.from('workers').select('id,name').eq('builder_id',builder).order('name')])
    if(p.error)throw p.error
    if(w.error)throw w.error
    return NextResponse.json({plan:p.data,workers:w.data,revision:d.job.profitability_revision,
      control:jobControl({revision:d.job.profitability_revision,contract:d.settings?.original_contract ?? null,
        baseline:d.settings?.baseline_items ?? [],actuals:d.actuals,approvedVariations:d.approved,uncostedHours:d.uncostedHours,
        taxReconciled:d.settings?.settings?.taxReconciled===true,plan:p.data,candidates:d.candidates})})
  }catch(e){return NextResponse.json({error:(e as Error).message},{status:(e as Error).message==='Job not found'?404:500})}
}
export async function PUT(req:NextRequest,{params}:{params:{jobId:string}}) {
  const builder=await getAuthenticatedBuilderId()
  if(!builder)return NextResponse.json({error:'Unauthorized'},{status:401})
  if(isDemoMode())return NextResponse.json({error:'Connect your account to save'},{status:400})
  try {
    const body=await req.json()
    if(!Number.isSafeInteger(body.revision)||body.revision<0)throw new Error('Refresh the job before saving')
    if(typeof body.confirm!=='boolean')throw new Error('Confirm whether the forecast is reconciled')
    const start=dateOnly(body.start_on,'Start'),finish=dateOnly(body.finish_on,'Finish'),cashDate=dateOnly(body.cash_as_of,'Cash as of')
    if(Boolean(start)!==Boolean(finish)||(start&&finish&&finish<start))throw new Error('Enter a finish on or after the start date')
    const received=body.cash_received==null?null:amount(body.cash_received,'Cash received'),paid=body.cash_paid==null?null:amount(body.cash_paid,'Cash paid')
    if((received!==null||paid!==null||cashDate!==null)&&(received===null||paid===null||!cashDate))throw new Error('Enter both cash totals and their reconciliation date')
    if(cashDate && cashDate>new Date().toISOString().slice(0,10))throw new Error('Actual cash cannot be dated in the future')
    const result=await intelligenceDB().rpc('save_job_control_plan',{p_builder:builder,p_job:params.jobId,p_revision:body.revision,p_confirm:body.confirm,
      p_plan:{start_on:start,finish_on:finish,lead_worker_id:body.lead_worker_id||null,cash_received:received,cash_paid:paid,cash_as_of:cashDate}})
    if(result.error)throw result.error
    return NextResponse.json({ok:true})
  }catch(e){return NextResponse.json({error:(e as Error).message},{status:400})}
}
