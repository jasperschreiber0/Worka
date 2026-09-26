import { NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { intelligenceDB, loadIntelligence, allRows } from '@/lib/profitability-data'
import { jobControl } from '@/lib/profit-control'
import { tileScenario, validateWorkflow, type WorkflowKind } from '@/lib/job-workflow'
export const dynamic = 'force-dynamic'

async function access(jobId: string) {
  const builder = await getAuthenticatedBuilderId()
  if (!builder || isDemoMode()) throw new Error('Sign in to save real job records')
  const db = intelligenceDB()
  const { data: job, error } = await db.from('jobs').select('id,address,profitability_revision').eq('id',jobId).eq('builder_id',builder).maybeSingle()
  if (error || !job) throw new Error('Job not found')
  return { builder, db, job }
}
export async function GET(_req: Request, { params }: { params: { jobId: string } }) {
  try {
    const { builder, db, job } = await access(params.jobId)
    const [records, files, facts, variations, events, jobs, drafts] = await Promise.all([
      allRows(() => db.from('job_workflow_records').select('*').eq('builder_id',builder).eq('job_id',job.id).order('created_at')),
      allRows(() => db.from('files').select('id,filename,created_at,drawing_state,intake_status,content_hash,duplicate_of_file_id').eq('builder_id',builder).eq('job_id',job.id).order('created_at')),
      allRows(() => db.from('project_facts').select('id,category,key,value,evidence,superseded,created_at').eq('job_id',job.id).eq('category','builder_answer').order('created_at')),
      allRows(() => db.from('variations').select('id,title,status,amount,approved_at').eq('builder_id',builder).eq('job_id',job.id).order('created_at')),
      allRows(() => db.from('job_workflow_events').select('id,record_id,action,created_at').eq('builder_id',builder).eq('job_id',job.id).order('id')),
      allRows(() => db.from('jobs').select('id,address').eq('builder_id',builder).order('id')),
      allRows(() => db.from('quotes').select('id,version,status').eq('builder_id',builder).eq('job_id',job.id).in('status',['draft','pending_review']).order('version')),
    ])
    const items=drafts.length?await allRows(()=>db.from('quote_line_items').select('id,quote_id,trade_category_id,description,total,assumption_status').in('quote_id',drafts.map(q=>q.id)).is('variation_id',null).order('id')):[]
    return NextResponse.json({ job, records, files, facts, variations, events, jobs,drafts,items })
  } catch (e) { return NextResponse.json({error:(e as Error).message},{status:(e as Error).message.startsWith('Sign in')?401:(e as Error).message==='Job not found'?404:400}) }
}
export async function POST(req: Request, { params }: { params: { jobId: string } }) {
  try {
    const { builder, db, job } = await access(params.jobId)
    const body = await req.json()
    if(body.action==='apply_trade_quote'){
      const {error}=await db.rpc('apply_job_trade_quote',{p_builder:builder,p_job:job.id,p_record:body.id,p_quote:body.quote_id,p_items:body.item_ids,p_version:body.version});if(error)throw Error(error.message)
      return NextResponse.json({saved:true})
    }
    if (!/^[0-9a-f-]{36}$/i.test(body.id) || !Number.isInteger(body.version) || !['save','confirm','complete','supersede'].includes(body.action)) throw new Error('Invalid record request')
    let payload = body.payload ?? {}, result = {}, kind = body.kind as WorkflowKind, title = body.title
    if (body.action === 'save') {
      payload = validateWorkflow(kind,title,payload)
      if (kind === 'selection') {
        const d = await loadIntelligence(builder,job.id)
        // A priced estimate is a scenario basis, not a claim of final job cost.
        const baselineComplete = d.baseline.length > 0 && d.baseline.every(r => r.assumption_status === 'excluded' || r.total !== null)
        const {data:plan,error:planError}=await db.from('job_control_plans').select('*').eq('job_id',job.id).eq('builder_id',builder).maybeSingle()
        if(planError)throw Error('Could not verify the job forecast. Retry before calculating.')
        const control=jobControl({revision:d.job.profitability_revision,contract:d.settings?.original_contract??null,baseline:d.baseline,actuals:d.actuals,approvedVariations:d.approved,uncostedHours:d.uncostedHours,taxReconciled:d.settings?.settings?.taxReconciled===true,plan,candidates:d.candidates})
        const originalOnly=d.approved===0 && d.costs.length===0 && baselineComplete
        result = {...tileScenario(payload,{revenue:control.revenue,cost:control.forecastCost??(originalOnly?d.baseline.filter(r=>r.assumption_status!=='excluded').reduce((s,r)=>s+Number(r.total),0):null)}),financial_basis:control.complete?'Builder-reconciled final-cost forecast':originalOnly?'Original estimate cost; no recorded actuals or approved variations':'Current cost forecast unresolved — confirm remaining costs and reconciliation'}
      }
    }
    const { data, error } = await db.rpc('save_job_workflow',{p_builder:builder,p_job:job.id,p_id:body.id,p_version:body.version,p_kind:kind ?? '',p_title:title ?? '',p_payload:payload,p_result:result,p_action:body.action,p_basis:body.basis_revision})
    if (error) throw new Error(error.code==='23505'?'This supplier invoice or credit is already recorded for this job':error.message)
    return NextResponse.json({ record:data })
  } catch(e) { return NextResponse.json({error:(e as Error).message},{status:(e as Error).message.startsWith('Sign in')?401:(e as Error).message==='Job not found'?404:400}) }
}
