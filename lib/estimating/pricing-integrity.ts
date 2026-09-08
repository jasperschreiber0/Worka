export interface ReviewLine {
  description: string; total: number | null; assumption_status?: string | null;
  rate?: number | null; quantity?: number | null; margin_pct?: number | null; pricing_source?: string | null;
}
const cents = (n: number) => Math.round((n + Number.EPSILON) * 100)
export function pricingIntegrityIssues(items: ReviewLine[], storedCost?: number | null): string[] {
  const included = items.filter(i => i.assumption_status !== 'excluded')
  const issues: string[] = []
  for (const i of included) {
    if (i.total != null && (!Number.isFinite(i.total) || i.total < 0)) issues.push(`Invalid amount: ${i.description}`)
    if (i.margin_pct != null && (!Number.isFinite(i.margin_pct) || i.margin_pct < 0)) issues.push(`Invalid markup: ${i.description}`)
    if (i.rate != null && i.quantity != null && i.total != null && cents(i.rate * i.quantity) !== cents(i.total)) issues.push(`Quantity × rate does not match the amount: ${i.description}`)
    if (i.pricing_source === 'category_rate') issues.push(`Supplier rate review required; category averages do not confirm this scope: ${i.description}`)
  }
  if (storedCost !== undefined) {
    const expected = included.reduce((sum,i) => sum + cents(i.total ?? 0),0)
    if (storedCost === null || cents(storedCost) !== expected) issues.push('Saved estimate cost does not match the included line amounts — reconcile before client issue')
  }
  return issues
}
export function shouldSavePrice(row: { rate: number | null; total: number | null }): boolean {
  return row.total !== null && Number.isFinite(row.total) && row.total >= 0
}
