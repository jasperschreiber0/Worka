import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'
import { loadIntelligence, intelligenceDB } from '@/lib/profitability-data'
import { intelligenceAI } from '@/lib/profitability-ai'
import { tradeCategoryName } from '@/lib/trade-taxonomy'
export async function POST(_req: NextRequest, { params }: { params: { jobId: string } }) {
  const builder = await getAuthenticatedBuilderId()
  if (!builder) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  if (isDemoMode())
    return NextResponse.json(
      { error: 'Connect your account to analyse a saved review' },
      { status: 400 },
    )
  try {
    const d = await loadIntelligence(builder, params.jobId),
      r = d.review
    if (!r.complete)
      throw new Error('Confirm the completed job review before requesting its post-mortem')
    const money = (n: number) =>
      new Intl.NumberFormat('en-AU', {
        style: 'currency',
        currency: 'AUD',
        maximumFractionDigits: 0,
      }).format(n)
    const facts = [
      {
        id: 'outcome',
        section: 'What happened',
        text: `Actual costs were ${money(r.actualCost)}, compared with ${money(r.estimatedCost)} estimated. The cost variance was ${money(r.variance)}${r.variancePct === null ? '' : ` (${r.variancePct.toFixed(1)}%)`}.`,
        evidence: 'Confirmed estimate and actual cost ledger',
      },
      {
        id: 'margin',
        section: 'Margin impact',
        text: `Expected margin ${r.expectedMargin?.toFixed(1) ?? 'unknown'}%; actual margin ${r.actualMargin?.toFixed(1) ?? 'unknown'}%. Movement: ${r.marginMovement?.toFixed(1) ?? 'unknown'} percentage points.`,
        evidence: 'Original contract, approved variation revenue and recorded costs',
      },
      ...r.trades.map((t) => ({
        id: `trade-${t.id}`,
        section: 'Biggest drivers',
        text: `${t.id === null ? 'Unclassified costs' : tradeCategoryName(t.id)}: ${money(Math.abs(t.variance))} ${t.variance >= 0 ? 'overrun' : 'saving'}; ${t.marginImpact === null ? 'margin impact unknown' : `${Math.abs(t.marginImpact).toFixed(1)} percentage points ${t.variance >= 0 ? 'reduction' : 'improvement'} against final revenue`}.${r.variance > 0 && t.variance > 0 ? ` This represents ${((t.variance / r.variance) * 100).toFixed(1)}% of the net cost overrun (savings in other trades can make this exceed 100%).` : ''}`,
        evidence: t.invoices.map((i) => i.invoice_ref || i.description).join(', '),
      })),
      {
        id: 'scope',
        section: 'Scope leakage',
        text: `${money(d.risk.unrecovered)} of builder-recorded change costs remain unrecovered. ${d.changesWithoutApprovedVariation} recorded changes have incurred costs without a recorded approved variation. ${d.risk.unknown} risks still have unknown cost impact. This does not prove they are final losses.`,
        evidence: d.candidates.map((c) => c.title).join(', ') || 'No scope-change cost evidence',
      },
      ...d.learning.map((l) => ({
        id: `learning-${l.trade}`,
        section: 'Pattern and recommendation',
        text: `${tradeCategoryName(l.trade)} averaged ${l.adjustmentPct}% variance across ${l.count} comparable completed jobs. ${l.confidence} confidence. Review this allowance on the next comparable estimate.`,
        evidence: l.jobs.join(', '),
      })),
      ...(d.learning.length ? [] : [{
        id: 'insufficient-history',
        section: 'Pattern and recommendation',
        text: 'There is insufficient comparable completed-job evidence for a historical adjustment. Reconcile the largest variances and record the supporting invoices, hours and reviewed scope changes before changing future allowances.',
        evidence: 'No matching confirmed history for this project context',
      }]),
      {
        id: 'limits',
        section: 'Evidence limits',
        text: 'Cost variances show where profit moved. The available records do not establish a cause unless supported by reviewed project correspondence. No causal explanation has been invented.',
        evidence: 'Evidence boundary',
      },
    ]
    const ai = await intelligenceAI(
      builder,
      params.jobId,
      'postmortem',
      'You are a profitability analyst. Select the most useful evidence cards in order, at most eight. Return only existing card IDs. All numbers and wording are already verified; do not calculate or invent explanations. Always include outcome, margin, scope and limits.',
      { facts },
      {
        type: 'object',
        properties: { ids: { type: 'array', items: { type: 'string' }, maxItems: 8 } },
        required: ['ids'],
      },
    )
    if (
      !Array.isArray(ai.ids) ||
      ai.ids.some((id: unknown) => typeof id !== 'string' || !facts.some((f) => f.id === id))
    )
      throw new Error('Analysis returned an unsupported evidence reference')
    const largestDriver = r.trades.find((t) => t.variance !== 0)
    const ids = Array.from(new Set(['outcome', ...(largestDriver ? [`trade-${largestDriver.id}`] : []), 'margin', ...ai.ids, 'scope', ...(d.learning.length ? [`learning-${d.learning[0].trade}`] : ['insufficient-history']), 'limits']))
    const cards = ids.map((id) => facts.find((f) => f.id === id)!)
    const event = await intelligenceDB()
      .from('proof_events')
      .insert({
        builder_id: builder,
        job_id: params.jobId,
        event_type: 'profitability_analysis',
        description: 'Evidence-backed profitability post-mortem',
        metadata: {
          cards,
          fingerprint: d.evidenceKey,
          source: 'AI-selected verified findings',
          builder_confirmed: false,
        },
      })
    if (event.error) throw event.error
    return NextResponse.json({ cards })
  } catch (e) {
    return NextResponse.json({ error: (e as Error).message }, { status: 400 })
  }
}
