import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { intelligenceDB, loadIntelligence } from '@/lib/profitability-data'
import { amount } from '@/lib/profitability'
export async function POST(req: NextRequest, { params }: { params: { jobId: string } }) {
  const builder = await getAuthenticatedBuilderId()
  if (!builder) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isDemoMode())
    return NextResponse.json({ error: 'Connect your account to apply learning' }, { status: 400 })
  try {
    const body = await req.json(),
      d = await loadIntelligence(builder, params.jobId)
    const recommendation = d.learning.find((l) => l.trade === body.trade)
    if (!recommendation || !d.quote)
      throw new Error('No supported recommendation for this estimate')
    if (!['apply', 'ignore'].includes(body.decision)) throw new Error('Choose apply or ignore')
    const pct = amount(
      body.adjustmentPct,
      'Allowance adjustment',
      body.decision === 'ignore' ? -100 : 0,
    )
    if (pct > 100) throw new Error('Review adjustments above 100% manually')
    const result = await intelligenceDB().rpc('apply_profitability_learning', {
      p_builder: builder,
      p_job: params.jobId,
      p_quote: d.quote.id,
      p_trade: body.trade,
      p_decision: body.decision,
      p_pct: pct,
      p_evidence: recommendation,
    })
    if (result.error)
      throw new Error(
        result.error.code === '23505'
          ? 'A decision has already been recorded for this trade on this estimate. Review its allowance in the estimate.'
          : result.error.message,
      )
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
