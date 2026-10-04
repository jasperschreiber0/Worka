// Isolated, fictional presentation project. No production records or APIs are used.
export const STUDIO_STORAGE_KEY = 'worka.project-studio.demo.v1'
export type Trade = 'Preliminaries' | 'Structure' | 'Envelope' | 'Interiors' | 'Services'
import { polygonArea, polygonPerimeter, wallArea, length, allWalls, allRooms, levels, floorArea, roofArea } from './studio-geometry.ts'
import type { Geometry } from './studio-geometry.ts'
export type Line = { id: string; trade: Trade; name: string; unit: string; quantity: number; rate: number; source: 'entered' | 'area' | 'perimeter' | 'wall-area' | 'wall-length' | 'openings' | 'room-area' | 'roof-area'; allowance: boolean; included: boolean; note: string; packagePart?: string; packageId?: string; packageName?: string; wallId?: string; roomId?:string; labour?: number; waste?: number; supplier?: string; quantityVerified?: boolean; rateVerified?: boolean }
export type Design = { width: number; depth: number; height: number; geometry?: Geometry }
export type Revision = { id: number; design: Design; lines: Line[]; markup: number; exclusions: string; impactReview?: {topic:string;status:string;note:string;signature:string}[] }
export type Variation = { id: string; status: 'draft' | 'approved'; from: Revision; to: Revision; createdAt: string; approvedAt?: string }
export type CostRecord = { trade: Trade; committed: number; actual: number; remaining?: number; complete?: boolean }
export type StudioProject = { schema: 1; id: string; working: Revision; baseline: Revision | null; variations: Variation[]; costs: CostRecord[]; receipts: number[] }
export const trades: Trade[] = ['Preliminaries', 'Structure', 'Envelope', 'Interiors', 'Services']
export const stages = [
  { name: 'Deposit', percent: 5, costPercent: 5 },
  { name: 'Site & slab', percent: 15, costPercent: 20 },
  { name: 'Frame', percent: 25, costPercent: 25 },
  { name: 'Lock-up', percent: 25, costPercent: 25 },
  { name: 'Fit-out', percent: 20, costPercent: 20 },
  { name: 'Completion', percent: 10, costPercent: 5 },
]
export const round = (value: number) => Math.round((value + Number.EPSILON) * 100) / 100
export const money = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 2, minimumFractionDigits: 2 }).format(value)
export const compactMoney = (value: number) => new Intl.NumberFormat('en-AU', { style: 'currency', currency: 'AUD', maximumFractionDigits: 0 }).format(value)
export function quantity(line: Line, design: Design) {
  const g=design.geometry, walls=g?allWalls(g).filter(w=>!line.wallId||w.id===line.wallId):[]
  return round(line.source==='room-area'?(g?allRooms(g).filter(r=>!line.roomId||r.id===line.roomId).reduce((s,r)=>s+polygonArea(r.polygon),0):0):line.source==='roof-area'?(g?levels(g).reduce((s,l)=>s+roofArea(l.geometry),0):0):line.source==='wall-area'?walls.reduce((s,w)=>s+wallArea(w),0):line.source==='wall-length'?walls.reduce((s,w)=>s+length(w.a,w.b),0):line.source==='openings'?walls.reduce((s,w)=>s+w.openings.length,0):line.source === 'area' ? (g?floorArea(g):design.width * design.depth) : line.source === 'perimeter' ? (g?levels(g).reduce((s,l)=>s+polygonPerimeter(l.geometry.footprint),0):2 * (design.width + design.depth)) : line.quantity)
}
export function lineCost(line: Line, design: Design) { return line.included ? round(quantity(line, design) * (line.rate*(1+(line.waste||0)/100)+(line.labour||0))) : 0 }
export function totals(revision: Revision) {
  const cost = round(revision.lines.reduce((sum, line) => sum + lineCost(line, revision.design), 0))
  const profit = round(cost * revision.markup / 100)
  const price = round(cost + profit)
  const gst = round(price * 0.1)
  return { cost, profit, price, gst, total: round(price + gst), margin: price ? profit / price * 100 : 0 }
}
export function quotePackages(revision: Revision) {
  const included = trades.filter(trade => revision.lines.some(l => l.trade === trade && l.included))
  let allocated = 0
  return included.map((trade, i) => {
    const lines = revision.lines.filter(l => l.trade === trade && l.included)
    const cost = round(lines.reduce((sum, l) => sum + lineCost(l, revision.design), 0))
    // Allocate the rounding remainder to the final package so displayed prices add up.
    const price = i === included.length - 1 ? round(totals(revision).price - allocated) : round(cost * (1 + revision.markup / 100))
    allocated = round(allocated + price)
    return { trade, lines, price }
  })
}
export function createDemoProject(): StudioProject {
  return {
    schema: 1, id: 'demo-gumtree', baseline: null, variations: [], receipts: stages.map(() => 0),
    working: {
      id: 1, design: { width: 8, depth: 6, height: 2.7 }, markup: 25,
      exclusions: 'Council and consultant fees; structural engineering; latent ground conditions; existing-house alterations outside the new opening; landscaping; loose furniture. Concept quantities and sample rates require builder verification.',
      lines: [
        { id: 'site', trade: 'Preliminaries', name: 'Site establishment & supervision', unit: 'item', quantity: 1, rate: 6500, source: 'entered', allowance: false, included: true, note: 'Manually entered sample scope.' },
        { id: 'slab', trade: 'Structure', name: 'Groundworks & concrete slab', unit: 'm²', quantity: 0, rate: 340, source: 'area', allowance: false, included: true, note: 'Gross footprint × rate. Flat site assumed; engineering pending.' },
        { id: 'frame', trade: 'Structure', name: 'Timber frame & roof structure', unit: 'm²', quantity: 0, rate: 280, source: 'area', allowance: false, included: true, note: 'Gross footprint allowance for framing. Not an engineered take-off.' },
        { id: 'roof', trade: 'Envelope', name: 'Roof covering & insulation', unit: 'm²', quantity: 0, rate: 170, source: 'area', allowance: false, included: true, note: 'Plan area proxy; pitch, overhangs and waste not measured.' },
        { id: 'walls', trade: 'Envelope', name: 'External wall package', unit: 'lm', quantity: 0, rate: 460, source: 'perimeter', allowance: false, included: true, note: 'Gross perimeter at 2.7 m wall height. Openings not deducted.' },
        { id: 'glazing', trade: 'Envelope', name: 'Windows & sliding door', unit: 'item', quantity: 1, rate: 12500, source: 'entered', allowance: true, included: true, note: 'Sample allowance; supplier quote required.' },
        { id: 'lining', trade: 'Interiors', name: 'Linings, painting & floor finishes', unit: 'm²', quantity: 0, rate: 220, source: 'area', allowance: false, included: true, note: 'Gross footprint proxy for the combined finishes package.' },
        { id: 'joinery', trade: 'Interiors', name: 'Kitchen joinery & appliances', unit: 'item', quantity: 1, rate: 18000, source: 'entered', allowance: true, included: true, note: 'Client selection allowance; illustrative cabinetry shown in 3D.' },
        { id: 'services', trade: 'Services', name: 'Electrical & plumbing', unit: 'item', quantity: 1, rate: 11000, source: 'entered', allowance: true, included: true, note: 'Fixed allowance; larger layouts need services review.' },
      ],
    },
    costs: trades.map(trade => ({ trade, committed: trade === 'Preliminaries' ? 6500 : trade === 'Structure' ? 22000 : 0, actual: trade === 'Preliminaries' ? 2500 : trade === 'Structure' ? 6000 : 0 })),
  }
}
export function acceptedRevision(project: StudioProject): Revision | null {
  return project.variations.filter(v => v.status === 'approved').at(-1)?.to ?? project.baseline
}
export function sameRevision(a: Revision, b: Revision) {
  return JSON.stringify({ ...a, id: 0 }) === JSON.stringify({ ...b, id: 0 })
}
export function revise(project: StudioProject, update: Partial<Omit<Revision, 'id'>>): StudioProject {
  return { ...project, working: { ...project.working, ...update, id: project.working.id + 1 } }
}
export function acceptEstimate(project: StudioProject): StudioProject {
  if (project.baseline || totals(project.working).cost <= 0) return project
  return { ...project, baseline: structuredClone(project.working) }
}
export function draftVariation(project: StudioProject, date = new Date().toISOString()): StudioProject {
  const from = acceptedRevision(project)
  if (!from || sameRevision(from, project.working)) return project
  const approved = project.variations.filter(v => v.status === 'approved')
  return { ...project, variations: [...approved, { id: `VAR-${String(approved.length + 1).padStart(3, '0')}`, status: 'draft', from: structuredClone(from), to: structuredClone(project.working), createdAt: date }] }
}
export function approveVariation(project: StudioProject, id: string, date = new Date().toISOString()): StudioProject {
  const item = project.variations.find(v => v.id === id)
  const accepted = acceptedRevision(project)
  if (!item || item.status !== 'draft' || !accepted || !sameRevision(item.from, accepted) || !sameRevision(item.to, project.working)) return project
  return { ...project, variations: project.variations.map(v => v.id === id ? { ...v, status: 'approved', approvedAt: date } : v) }
}
export function variationDelta(variation: Variation) {
  const before = totals(variation.from), after = totals(variation.to)
  return { cost: round(after.cost - before.cost), price: round(after.price - before.price), gst: round(after.gst - before.gst), total: round(after.total - before.total) }
}
export function financials(project: StudioProject) {
  const revision = acceptedRevision(project) ?? project.working
  const base = project.baseline ?? project.working
  const budget = totals(revision)
  const rows = trades.map(trade => {
    const cost = project.costs.find(row => row.trade === trade)!
    const tradeBudget = round(revision.lines.filter(line => line.trade === trade).reduce((sum, line) => sum + lineCost(line, revision.design), 0))
    const remainingCommitted = round(Math.max(0, cost.committed - cost.actual))
    const uncommitted = round(Math.max(0, tradeBudget - Math.max(cost.committed, cost.actual)))
    return { ...cost, budget: tradeBudget, remainingCommitted, uncommitted, forecast: cost.complete ? Math.max(cost.actual,cost.committed) : round(cost.actual + remainingCommitted + (cost.remaining ?? uncommitted)) }
  })
  const sum = (key: 'actual' | 'committed' | 'remainingCommitted' | 'uncommitted' | 'forecast') => round(rows.reduce((s, row) => s + row[key], 0))
  const forecast = sum('forecast')
  const profit = round(budget.price - forecast)
  return { rows, revenue: budget.price, baseline: totals(base).cost, budget: budget.cost, forecast, profit, margin: budget.price ? profit / budget.price * 100 : 0, actual: sum('actual'), committed: sum('committed'), remainingCommitted: sum('remainingCommitted'), uncommitted: sum('uncommitted') }
}
export function paymentSchedule(project: StudioProject) {
  const finance = financials(project)
  let allocated = 0, allocatedCost = 0, cumulative = 0
  return stages.map((stage, i) => {
    const amount = i === stages.length - 1 ? round(finance.revenue - allocated) : round(finance.revenue * stage.percent / 100)
    const cost = i === stages.length - 1 ? round(finance.forecast - allocatedCost) : round(finance.forecast * stage.costPercent / 100)
    allocated = round(allocated + amount); allocatedCost = round(allocatedCost + cost)
    cumulative = round(cumulative + amount - cost)
    return { ...stage, amount, cost, received: project.receipts[i], cumulative }
  })
}

// Reject corrupt or unrelated local data instead of allowing NaN into a presentation.
export function parseProject(raw: string): StudioProject | null {
  try {
    const p = JSON.parse(raw) as StudioProject
    const validNumber = (v: unknown, max = 1e9) => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= max
    const revisionValid = (r: Revision) => r && validNumber(r.id) && validNumber(r.markup, 100) && typeof r.exclusions === 'string' &&
      r.design && r.design.width >= 7 && r.design.width <= 10 && r.design.depth === 6 && r.design.height === 2.7 &&
      Array.isArray(r.lines) && r.lines.length > 0 && new Set(r.lines.map(l => l.id)).size === r.lines.length && r.lines.every(l =>
        typeof l.id === 'string' && typeof l.name === 'string' && typeof l.note === 'string' && typeof l.unit === 'string' &&
        trades.includes(l.trade) && ['entered', 'area', 'perimeter'].includes(l.source) && typeof l.included === 'boolean' && typeof l.allowance === 'boolean' && validNumber(l.quantity, 100000) && validNumber(l.rate, 1000000))
    if (p.schema !== 1 || p.id !== 'demo-gumtree' || !revisionValid(p.working) || (p.baseline !== null && !revisionValid(p.baseline))) return null
    const stableLines = (r: Revision) => r.lines.length === p.working.lines.length && p.working.lines.every(l => r.lines.some(old => old.id === l.id))
    if (p.baseline && !stableLines(p.baseline)) return null
    if (!Array.isArray(p.variations) || p.variations.some(v => !['draft', 'approved'].includes(v.status) || typeof v.id !== 'string' || !revisionValid(v.from) || !revisionValid(v.to) || !stableLines(v.from) || !stableLines(v.to) || !Number.isFinite(Date.parse(v.createdAt)) || (v.status === 'approved' && !Number.isFinite(Date.parse(v.approvedAt || ''))))) return null
    if (!Array.isArray(p.costs) || p.costs.length !== trades.length || trades.some(t => p.costs.filter(c => c.trade === t).length !== 1) || p.costs.some(c => !validNumber(c.committed) || !validNumber(c.actual))) return null
    if (!Array.isArray(p.receipts) || p.receipts.length !== stages.length || p.receipts.some(v => !validNumber(v))) return null
    if (!p.baseline && p.variations.length) return null
    let prior = p.baseline, draftSeen = false
    for (const v of p.variations) {
      if (!prior || draftSeen || !sameRevision(v.from, prior)) return null
      if (v.status === 'approved') prior = v.to
      else draftSeen = true
    }
    if (new Set(p.variations.map(v => v.id)).size !== p.variations.length) return null
    return p
  } catch { return null }
}
