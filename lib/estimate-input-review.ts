export interface InputReviewItem {
  assumption_status: string | null
  is_assumption: boolean
  total: number | null
  review_state?: string | null
  pricing_source?: string | null
}

export function estimateInputReason(item: InputReviewItem): string | null {
  if (item.assumption_status === 'excluded') return null
  if (item.review_state === 'awaiting_quote') return 'Awaiting supplier quote'
  if (item.total === null || !Number.isFinite(item.total) || item.total <= 0) return 'Price needed'
  if (item.is_assumption && item.assumption_status === 'unresolved') return 'Confirm assumption'
  if (item.assumption_status !== 'accepted' && item.assumption_status !== 'adjusted' &&
      ['ai_allowance', 'ai_measured_rate', 'category_rate'].includes(item.pricing_source ?? '')) return 'Check allowance or rate'
  return null
}