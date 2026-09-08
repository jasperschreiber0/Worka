/** Costs supplied here must be mutually exclusive: commitments are outstanding balances. */
export function calculateJobProfit(input: {
  contract: number | null; approvedVariations: number; actual: number;
  outstandingCommitments: number; remaining: number | null; uncostedHours: number;
  reconciled: boolean;
}) {
  const amounts = [input.contract, input.approvedVariations, input.actual, input.outstandingCommitments, input.remaining, input.uncostedHours]
  if (amounts.some(value => value !== null && !Number.isFinite(value))) throw new Error('Financial inputs must be finite')
  if (input.actual < 0 || input.outstandingCommitments < 0 || (input.remaining !== null && input.remaining < 0) || input.uncostedHours < 0) throw new Error('Costs and hours cannot be negative')
  const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
  const reasons: string[] = []
  if (input.contract === null) reasons.push('Contract value is missing')
  if (input.remaining === null) reasons.push('Remaining work has not been estimated')
  if (input.uncostedHours > 0) reasons.push('Labour hours need costing')
  if (!input.reconciled) reasons.push('Costs and commitments need reconciliation')
  const revenue = input.contract === null ? null : round(input.contract + input.approvedVariations)
  const knownCost = round(input.actual + input.outstandingCommitments + (input.remaining ?? 0))
  const complete = reasons.length === 0
  const profit = complete && revenue !== null ? round(revenue - knownCost) : null
  return { revenue, knownCost, complete, reasons, forecastCost: complete ? knownCost : null, profit, margin: profit !== null && revenue !== null && revenue > 0 ? round(profit / revenue * 100) : null }
}
