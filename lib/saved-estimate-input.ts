/** Explicit builder pricing uses unit rates for measured work and lump sums for allowances. */
export function savedInputPricing(item: { quantity: number | null; unit: string | null; rate: number | null; total: number | null; pricing_type: string; assumption_status: string | null }, edit: { quantity?: number | null; unit?: string | null; rate?: number | null }) {
 const quantity = edit.quantity === undefined ? item.quantity : edit.quantity
 const unit = edit.unit === undefined ? item.unit : edit.unit
 const rate = edit.rate === undefined ? item.rate : edit.rate
 const allowance = ['pc_allowance', 'provisional_sum'].includes(item.pricing_type)
 const pricingChanged = edit.rate !== undefined || edit.quantity !== undefined
 const total = !pricingChanged ? item.total : rate === null ? (edit.rate === null ? null : item.total) : allowance ? rate : quantity === null ? null : Math.round(quantity * rate * 100) / 100
 const complete = total !== null && Number.isFinite(total) && total > 0 && (allowance || (quantity !== null && quantity > 0 && !!unit?.trim() && rate !== null && rate > 0))
 return { total, ...(edit.rate !== undefined && item.assumption_status !== 'excluded' ? { assumption_status: complete ? 'adjusted' : 'unresolved' } : {}) }
}
