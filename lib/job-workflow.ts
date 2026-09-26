import { amount, roundMoney } from './profitability.ts'
import { dateOnly } from './profit-control.ts'

export const WORKFLOW_KINDS = ['purchase_order', 'bill', 'selection', 'programme', 'scope_pack', 'site_update', 'question', 'deadline', 'trade_quote', 'material_transfer'] as const
export type WorkflowKind = typeof WORKFLOW_KINDS[number]
export type WorkflowRecord = { id: string; job_id: string; kind: WorkflowKind; title: string; status: string; version: number; basis_revision: number; payload: Record<string, any>; result: Record<string, any>; linked_id: string | null; created_at: string }
export function text(value: unknown, label: string, required = false, max = 8000): string {
  if (value == null && !required) return ''
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw new Error(`${label} is required and must be shorter than ${max} characters`)
  return value.trim()
}
export function exGST(value: unknown, basis: unknown) {
  if (!['exclusive', 'inclusive'].includes(String(basis))) throw new Error('Declare whether the source amount includes GST')
  amount(value, 'Source amount', -999999999)
  return roundMoney((value as number) / (basis === 'inclusive' ? 1.1 : 1))
}
export function tileScenario(p: Record<string, any>, financial?: { revenue: number | null; cost: number | null }) {
  const area = amount(p.area, 'Tile area'), wastage = amount(p.wastage_pct, 'Wastage')
  if (!area || wastage > 100) throw new Error('Enter a positive measured area and wastage between 0% and 100%')
  text(p.room, 'Room', true)
  if (p.price_basis !== 'purchase_cost') throw new Error('Confirm the original and proposed purchase costs. A client allowance is not a supplier cost.')
  if (p.installation !== 'supply_only' && p.installation !== 'same_installation') throw new Error('Confirm installation treatment before calculating the difference')
  if (p.original_rate < 0 || p.proposed_rate < 0) throw new Error('Unit prices cannot be negative')
  const original = exGST(p.original_rate, p.original_gst), proposed = exGST(p.proposed_rate, p.proposed_gst)
  const supply = roundMoney(area * (1 + wastage / 100) * (proposed - original))
  const extras = p.extras === null || p.extras === '' || p.extras === undefined ? null : amount(p.extras, 'Other supported costs', -999999999)
  if (extras && !text(p.extra_evidence, 'Evidence for extra costs')) throw new Error('Record evidence for delivery, labour, returns or other adjustments')
  const cost = extras === null ? null : roundMoney(supply + extras)
  const markup = amount(p.markup_pct, 'Markup')
  if (markup > 1000) throw new Error('Review the markup percentage')
  const charge = cost === null ? null : roundMoney(cost * (1 + markup / 100))
  const revenue = financial?.revenue ?? null, baseCost = financial?.cost ?? null
  const absorbed = revenue === null || baseCost === null || cost === null ? null : roundMoney(revenue - baseCost - cost)
  const charged = absorbed === null || charge === null ? null : roundMoney(absorbed + charge)
  const money = (n: number) => n.toLocaleString('en-AU', { style: 'currency', currency: 'AUD' })
  return { supply_delta: supply, expected_cost: cost, proposed_charge: charge, gst: charge === null ? null : roundMoney(charge * .1),
    absorbed_profit: absorbed, charged_profit: charged,
    absorbed_margin: absorbed === null || !revenue ? null : roundMoney(absorbed / revenue * 100),
    charged_margin: charged === null || revenue === null || charge === null || revenue + charge <= 0 ? null : roundMoney(charged / (revenue + charge) * 100),
    programme_effect: text(p.programme_effect, 'Programme effect') || 'Unknown — review lead times and affected activities',
    ready: cost !== null && p.reviewed === true,
    email_draft: `Proposed tile selection for ${p.room}: ${area} m², from ${money(original)} to ${money(proposed)} per m² excluding GST. Supply difference ${money(supply)}. ${charge === null ? 'Other costs remain unresolved; no final price is offered.' : `Proposed variation ${money(charge)} excluding GST (${money(roundMoney(charge * 1.1))} including GST).`} This is a draft for review, not client approval.`,
  }
}
export function validateWorkflow(kind: WorkflowKind, title: unknown, input: Record<string, any>) {
  if (!WORKFLOW_KINDS.includes(kind)) throw new Error('Choose a supported job record')
  text(title, 'Title', true, 200)
  if (!input || typeof input !== 'object' || Array.isArray(input) || JSON.stringify(input).length > 40000) throw new Error('Record is too large')
  const p = { ...input }
  for (const field of ['due_on', 'invoice_on', 'start_on', 'finish_on', 'approval_date']) if (field in p) p[field] = dateOnly(p[field], field.replaceAll('_', ' '))
  if (p.trade_id != null && p.trade_id !== '' && (!Number.isInteger(Number(p.trade_id)) || Number(p.trade_id) < 1 || Number(p.trade_id) > 13)) throw new Error('Choose a canonical trade or Unclassified')
  if (p.start_on && p.finish_on && p.finish_on < p.start_on) throw new Error('Finish date must follow the start date')
  if (kind==='material_transfer') { p.net_amount=exGST(p.source_amount,p.tax_basis); if(p.net_amount<=0)throw new Error('Enter a positive evidenced transfer value');text(p.to_job_id,'Receiving job',true);text(p.evidence,'Quantity, supplier and valuation evidence',true) }
  if (['purchase_order', 'bill', 'trade_quote'].includes(kind)) {
    text(p.supplier, 'Supplier', true, 200)
    p.net_amount = exGST(p.source_amount, p.tax_basis)
    if (kind !== 'bill' && p.net_amount < 0) throw new Error('Use a credit bill for a negative adjustment')
    if (kind === 'bill') { text(p.invoice_ref, 'Invoice or credit reference', true, 200); p.release_amount = amount(p.release_amount ?? 0, 'Commitment amount being replaced') }
  }
  for(const key of ['file_ids','dependencies'])if(p[key]!=null&&(!Array.isArray(p[key])||p[key].length>100||p[key].some((id:unknown)=>typeof id!=='string'||!/^[0-9a-f-]{36}$/i.test(id))))throw new Error('Choose valid linked records')
  if(kind==='bill'&&p.percent_complete!=null&&(amount(p.percent_complete,'Completion percentage')>100))throw new Error('Completion cannot exceed 100%')
  if(p.labour_hours!=null)amount(p.labour_hours,'Explicit labour hours')
  if (kind === 'programme') {
    text(p.owner, 'Responsible person or trade', true, 200)
    if (!p.start_on || !p.finish_on) throw new Error('Enter proposed start and finish dates')
  }
  if (kind === 'scope_pack') {
    for (const field of ['inclusions', 'exclusions', 'responsibilities', 'finish_standard', 'clean_up', 'hold_points']) text(p[field], field.replaceAll('_', ' '), true)
    if (!['labour_only', 'supply_install', 'split'].includes(p.arrangement)) throw new Error('Confirm supply responsibilities')
  }
  return p
}
export function programmeReadiness(record: WorkflowRecord, records: WorkflowRecord[], today: string) {
  const dependencies = Array.isArray(record.payload.dependencies) ? record.payload.dependencies : []
  const blockers = dependencies.filter((id: string) => !records.some(r => r.id === id && r.status === 'completed')).map((id: string) => records.find(r => r.id === id)?.title ?? 'Missing dependency')
  for (const r of records) if (r.payload.activity_id === record.id && !['completed', 'superseded'].includes(r.status) && r.kind !== 'programme') blockers.push(r.title)
  return { blockers, overdue: !!record.payload.finish_on && record.payload.finish_on < today && record.status !== 'completed' }
}
