import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { intelligenceDB, allRows } from '@/lib/profitability-data'
import { EMPTY_PROFILE, financialProfile, cashForecast } from '@/lib/profitability'
import { dateOnly } from '@/lib/profit-control'
export async function GET() {
  const builder = await getAuthenticatedBuilderId()
  if (!builder) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isDemoMode())
    return NextResponse.json({ profile: EMPTY_PROFILE, cash_flow: null, jobs: [], demo: true })
  try {
    const db = intelligenceDB()
    const result = await db
      .from('business_financial_profiles')
      .select('*')
      .eq('builder_id', builder)
      .maybeSingle()
    if (result.error) throw result.error
    const jobs = await allRows(() =>
      db
        .from('jobs')
        .select('id,address,status,job_type')
        .eq('builder_id', builder)
        .order('created_at', { ascending: false })
        .order('id'),
    )
    const risks = await allRows(() =>
      db
        .from('profitability_candidates')
        .select('estimated_cost,incurred,recovered,status')
        .eq('builder_id', builder)
        .order('id'),
    )
    return NextResponse.json({
      ...result.data,
      profile: result.data?.profile ?? EMPTY_PROFILE,
      jobs,
      risks,
      demo: false,
    })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 500 })
  }
}
export async function PUT(req: NextRequest) {
  const builder = await getAuthenticatedBuilderId()
  if (!builder) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isDemoMode())
    return NextResponse.json(
      { error: 'Connect your business account to save these figures' },
      { status: 400 },
    )
  try {
    const body = await req.json()
    if (body.profile) financialProfile(body.profile)
    if (body.cash_flow) {
      if(body.cash_flow.plan) throw new Error('Save detailed forecasts through the cash planner')
      cashForecast(body.cash_flow.opening, body.cash_flow.weeks)
      if (!dateOnly(body.cash_flow.startOn, 'Forecast start')) throw new Error('Enter the forecast start date')
      if (typeof body.cash_flow.complete !== 'boolean') throw new Error('Confirm whether forecast inputs are complete')
    }
    if (!body.profile && !body.cash_flow) throw new Error('No changes supplied')
    const payload = {
      builder_id: builder,
      updated_at: new Date().toISOString(),
      ...(body.profile ? { profile: body.profile } : {}),
      ...(body.cash_flow ? { cash_flow: body.cash_flow } : {}),
    }
    const db=intelligenceDB()
    // Old browser tabs must not overwrite a newer detailed plan or a concurrent save.
    if(body.cash_flow){
      const current=await db.from('business_financial_profiles').select('cash_flow,updated_at').eq('builder_id',builder).maybeSingle()
      if(current.error) throw current.error
      if(current.data?.cash_flow?.plan) throw new Error('Your cash plan now has payment details. Reload and use the cash planner.')
      const saved=current.data
        ? await db.from('business_financial_profiles').update(payload).eq('builder_id',builder).eq('updated_at',current.data.updated_at).select('builder_id').maybeSingle()
        : await db.from('business_financial_profiles').insert(payload).select('builder_id').single()
      if(saved.error) throw saved.error
      if(!saved.data) throw new Error('Cash forecast changed. Reload before saving.')
      return NextResponse.json({ok:true})
    }
    const result = await db.from('business_financial_profiles').upsert(payload)
    if (result.error) throw result.error
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
