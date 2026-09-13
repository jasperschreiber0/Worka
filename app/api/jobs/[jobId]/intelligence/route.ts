import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { intelligenceDB, loadIntelligence } from '@/lib/profitability-data'
import { amount, percent, profitabilityReview } from '@/lib/profitability'
export async function GET(_req: NextRequest, { params }: { params: { jobId: string } }) {
  const builder = await getAuthenticatedBuilderId()
  if (!builder) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isDemoMode())
    return NextResponse.json(
      { error: 'Connect your account and select a saved job to review profitability' },
      { status: 400 },
    )
  try {
    return NextResponse.json(
      await loadIntelligence(
        builder,
        params.jobId,
        _req.nextUrl.searchParams.get('quoteId') ?? undefined,
      ),
    )
  } catch (e) {
    return NextResponse.json(
      { error: (e as Error).message },
      { status: (e as Error).message === 'Job not found' ? 404 : 500 },
    )
  }
}
export async function POST(req: NextRequest, { params }: { params: { jobId: string } }) {
  const builder = await getAuthenticatedBuilderId()
  if (!builder) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isDemoMode())
    return NextResponse.json({ error: 'Connect your account to save' }, { status: 400 })
  try {
    const body = await req.json(),
      data = await loadIntelligence(builder, params.jobId),
      db = intelligenceDB()
    if (body.action === 'settings') {
      amount(body.originalContract, 'Original contract')
      const s = body.settings
      if (!['exclusive', 'inclusive'].includes(s?.sourceTaxBasis) || s?.taxReconciled !== true)
        throw new Error('Declare the project source GST basis and confirm reconciliation to AUD excluding GST. Existing values are not converted.')
      if (typeof s?.labourIncluded !== 'boolean') throw new Error('Confirm the labour basis')
      if (s.size !== null) amount(s.size, 'Project size')
      if (s.targetMargin !== null) percent(s.targetMargin, 'Target margin')
      percent(s.contingency ?? 0, 'Contingency')
      for (const hours of Object.values(s.estimatedHours ?? {})) amount(hours, 'Estimated hours')
      if (body.captureBaseline && !data.quote) throw new Error('Create an estimate first')
      if(body.captureBaseline && (!data.baseline.length || data.baseline.some(item=>item.assumption_status!=='excluded' && item.total===null)))
        throw new Error('Resolve missing estimate prices before capturing the original baseline')
      if (data.settings?.baseline_items?.length && body.captureBaseline)
        throw new Error('The original estimate is already captured')
      const r = await db.rpc('save_profitability_settings', {
        p_builder: builder,
        p_job: params.jobId,
        p_contract: body.originalContract,
        p_settings: s,
        p_capture: !!body.captureBaseline,
        p_quote: data.quote?.id ?? null,
        p_items: data.baseline,
      })
      if (r.error) throw r.error
    } else if (body.action === 'complete') {
      if (body.confirmed !== true)
        throw new Error('Confirm all costs, variation revenue and labour are reconciled')
      if (!data.settings?.baseline_items?.length)
        throw new Error('Capture the original estimate and contract first')
      if (!['exclusive', 'inclusive'].includes(data.settings.settings?.sourceTaxBasis) || data.settings.settings?.taxReconciled !== true)
        throw new Error('Reconcile the project GST treatment in Financial gate before confirming this review')
      if (body.mappingsConfirmed !== true)
        throw new Error('Confirm the actual-cost trade mappings, including costs left Unclassified')
      if (data.uncostedHours > 0) throw new Error('Cost all labour hours first')
      if (data.costs.some((c) => c.cost_kind === 'committed' || c.cost_kind === 'remaining'))
        throw new Error(
          'Reconcile outstanding commitments and remaining cost entries in Job Money first',
        )
      const review = profitabilityReview(
        data.baseline,
        data.actuals,
        data.originalContract,
        data.approved,
        true,
        data.settings.settings?.estimatedHours ?? {},
      )
      if (!review.complete)
        throw new Error('Resolve missing estimate costs before confirming completion')
      const r = await db.rpc('confirm_profitability_review',{
          p_job: params.jobId,
          p_builder: builder,
          p_revision:data.job.profitability_revision??0,
          p_context: data.context,
          p_review:review,
          p_evidence: {
            fingerprint: data.evidenceKey,
            costIds: data.actuals.map((c) => c.id),
            quoteId: data.settings.baseline_quote_id,
            currency: 'AUD',
            calculationTaxBasis: 'exclusive',
            sourceTaxBasis: data.settings.settings.sourceTaxBasis,
            taxReconciled: true,
            mappingsConfirmed: true,
          },
        })
      if (r.error) throw r.error
    } else if (body.action === 'candidate') {
      if (!data.candidates.some((c) => c.id === body.id)) throw new Error('Candidate not found')
      const v = body.values
      for (const k of ['incurred', 'billed', 'recovered']) amount(v[k], k)
      for (const k of ['estimated_cost', 'proposed_charge']) if (v[k] !== null) amount(v[k], k)
      const r = await db.rpc('review_profitability_candidate', {
        p_builder: builder,
        p_id: body.id,
        p_values: v,
      })
      if (r.error) throw r.error
    } else if (body.action === 'variation') {
      if (!data.candidates.some((c) => c.id === body.id)) throw new Error('Candidate not found')
      const r = await db.rpc('create_profitability_variation', {
        p_builder: builder,
        p_candidate: body.id,
      })
      if (r.error) throw r.error
    } else if (body.action === 'track_variation') {
      const v = data.untrackedVariations.find((v) => v.id === body.id)
      if (!v) throw new Error('Variation not found or already tracked')
      const r = await db
        .from('profitability_candidates')
        .insert({
          job_id: params.jobId,
          builder_id: builder,
          variation_id: v.id,
          title: v.title,
          requested_change: v.description,
          evidence: `Existing variation: ${v.description}`,
          trade_category_id: v.trade_category_id,
          estimated_cost:
            v.labour_cost !== null || v.materials_cost !== null
              ? Number(v.labour_cost ?? 0) + Number(v.materials_cost ?? 0)
              : null,
          proposed_charge: v.amount,
          status: v.status === 'draft' ? 'potential' : v.status === 'pending' ? 'sent' : v.status,
          builder_confirmed: true,
        })
      if (r.error) throw r.error
    } else if (body.action === 'risk') {
      if (
        typeof body.description !== 'string' ||
        !body.description.trim() ||
        body.description.length > 10000
      )
        throw new Error('Enter the risk and its evidence')
      const r = await db.rpc('record_profitability_correspondence', {
        p_builder: builder,
        p_job: params.jobId,
        p_analysis: {
          type: 'possible_scope_change',
          title: body.description.slice(0, 180),
          excerpt: body.description,
          trade: null,
          confidence: null,
        },
        p_source: { provider: 'builder', text: body.description },
      })
      if (r.error) throw r.error
    } else if (body.action === 'note') {
      if (
        typeof body.description !== 'string' ||
        !body.description.trim() ||
        body.description.length > 10000
      )
        throw new Error('Enter a note of 1–10,000 characters')
      if (
        ![
          'builder_note',
          'RFI',
          'client_decision',
          'architect_instruction',
          'cost_event',
          'approval',
        ].includes(body.type)
      )
        throw new Error('Choose an event type')
      const r = await db
        .from('proof_events')
        .insert({
          job_id: params.jobId,
          builder_id: builder,
          event_type: body.type,
          description: body.description,
          metadata: {
            source: 'builder',
            person: body.person || null,
            trade_category_id: body.trade ?? null,
            evidence: body.evidence || null,
            builder_confirmed: true,
          },
        })
      if (r.error) throw r.error
    } else if (body.action === 'classify') {
      const old = data.costs.find((c) => c.id === body.id)
      if (!old) throw new Error('Cost not found')
      if (
        body.trade !== null &&
        (!Number.isInteger(body.trade) || body.trade < 1 || body.trade > 13)
      )
        throw new Error('Choose a valid trade')
      const r = await db.rpc('classify_profitability_cost', {
        p_builder: builder,
        p_job: params.jobId,
        p_cost: body.id,
        p_trade: body.trade,
        p_category: body.category,
      })
      if (r.error) throw r.error
    } else throw new Error('Unknown action')
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
