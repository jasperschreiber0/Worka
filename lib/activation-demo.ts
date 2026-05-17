// ─── Session 14: Activation demo data ────────────────────────────────────────
// In-memory demo state and data generators for the job activation flow.

import { randomUUID } from 'crypto'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface DemoMilestone {
  id: string
  job_id: string
  title: string
  description: string | null
  due_date: string | null   // ISO date
  due_display: string | null  // "Week 3", "Week 8", etc.
  completed_at: string | null
  sort_order: number
}

export interface DemoInvoiceScheduleItem {
  id: string
  job_id: string
  label: string
  percentage: number
  amount: number
  due_trigger: string
  invoice_id: string | null
}

export interface DemoProofEvent {
  id: string
  job_id: string
  event_type: string
  description: string
  metadata: Record<string, unknown> | null
  created_at: string
  display_time: string  // plain English
}

// ─── In-memory activation state ───────────────────────────────────────────────

export const demoActivationState = new Map<string, {
  activated: boolean
  activated_at: string | null
  milestones: DemoMilestone[]
  invoice_schedule: DemoInvoiceScheduleItem[]
  proof_events: DemoProofEvent[]
}>()

// ─── Milestone template ───────────────────────────────────────────────────────

interface MilestoneTemplate {
  title: string
  description: string
  week: number
  sort_order: number
}

const MILESTONE_TEMPLATES: MilestoneTemplate[] = [
  {
    title: 'Contract signed',
    description: 'Signed contract received and filed. Work order issued.',
    week: 0,
    sort_order: 1,
  },
  {
    title: 'Site prep & demolition complete',
    description: 'Site cleared, demolition completed, waste removed.',
    week: 2,
    sort_order: 2,
  },
  {
    title: 'Rough-in complete — plumbing & electrical',
    description: 'Rough plumbing and electrical first-fix completed.',
    week: 5,
    sort_order: 3,
  },
  {
    title: 'Frame inspection passed',
    description: 'Council frame inspection passed. Progress claim triggered.',
    week: 7,
    sort_order: 4,
  },
  {
    title: 'Lock-up achieved',
    description: 'External walls, roof, windows, and doors installed. Site is secure.',
    week: 10,
    sort_order: 5,
  },
  {
    title: 'Fix-out complete',
    description: 'Internal linings, cabinetry, fit-out carpentry, and fixtures installed.',
    week: 14,
    sort_order: 6,
  },
  {
    title: 'Practical completion',
    description: 'All works substantially complete. Defects list issued to client.',
    week: 16,
    sort_order: 7,
  },
  {
    title: 'Final inspection passed',
    description: 'All defects rectified. Occupation certificate issued.',
    week: 17,
    sort_order: 8,
  },
]

// ─── Invoice schedule template ─────────────────────────────────────────────────

interface InvoiceTemplate {
  label: string
  percentage: number
  due_trigger: string
}

const INVOICE_TEMPLATES: InvoiceTemplate[] = [
  {
    label: 'Deposit',
    percentage: 10,
    due_trigger: 'On contract signing',
  },
  {
    label: 'Frame stage',
    percentage: 20,
    due_trigger: 'Frame inspection passed',
  },
  {
    label: 'Lock-up',
    percentage: 25,
    due_trigger: 'Lock-up achieved',
  },
  {
    label: 'Fix-out',
    percentage: 25,
    due_trigger: 'Fix-out complete',
  },
  {
    label: 'Completion',
    percentage: 20,
    due_trigger: 'Practical completion',
  },
]

// ─── Generator: milestones ────────────────────────────────────────────────────

/**
 * Generate the standard 8-milestone set for a residential renovation.
 * Due dates are calculated forward from today by the template week offsets.
 */
export function generateMilestones(jobId: string, _totalCost: number): DemoMilestone[] {
  const today = new Date()

  return MILESTONE_TEMPLATES.map((template) => {
    const dueDate = new Date(today)
    dueDate.setDate(dueDate.getDate() + template.week * 7)
    const isWeekZero = template.week === 0

    return {
      id: randomUUID(),
      job_id: jobId,
      title: template.title,
      description: template.description,
      due_date: dueDate.toISOString().split('T')[0],
      due_display: isWeekZero ? 'Today' : `Week ${template.week}`,
      completed_at: null,
      sort_order: template.sort_order,
    }
  })
}

// ─── Generator: invoice schedule ─────────────────────────────────────────────

/**
 * Generate the standard 5-stage invoice schedule.
 * Amounts are calculated from total_cost using the standard percentages (10/20/25/25/20).
 */
export function generateInvoiceSchedule(jobId: string, totalCost: number): DemoInvoiceScheduleItem[] {
  return INVOICE_TEMPLATES.map((template) => {
    const amount = Math.round((totalCost * template.percentage) / 100 * 100) / 100
    return {
      id: randomUUID(),
      job_id: jobId,
      label: template.label,
      percentage: template.percentage,
      amount,
      due_trigger: template.due_trigger,
      invoice_id: null,
    }
  })
}

// ─── Helper: format plain English time ───────────────────────────────────────

export function formatDisplayTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diffMs = now.getTime() - date.getTime()
  const diffSeconds = Math.floor(diffMs / 1000)
  const diffMinutes = Math.floor(diffSeconds / 60)
  const diffHours = Math.floor(diffMinutes / 60)
  const diffDays = Math.floor(diffHours / 24)

  if (diffSeconds < 60) return 'just now'
  if (diffMinutes < 60) return `${diffMinutes} minute${diffMinutes !== 1 ? 's' : ''} ago`
  if (diffHours < 24) return `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`
  if (diffDays === 1) return 'yesterday'
  if (diffDays < 7) return `${diffDays} days ago`
  const diffWeeks = Math.floor(diffDays / 7)
  if (diffWeeks < 5) return `${diffWeeks} week${diffWeeks !== 1 ? 's' : ''} ago`
  const diffMonths = Math.floor(diffDays / 30)
  return `${diffMonths} month${diffMonths !== 1 ? 's' : ''} ago`
}

// ─── Helper: proof event colour ──────────────────────────────────────────────

export type ProofEventColour = 'green' | 'amber' | 'slate'

export function proofEventColour(eventType: string): ProofEventColour {
  const positiveTypes = new Set([
    'job_activated',
    'variation_approved',
    'invoice_paid',
    'milestone_complete',
    'quote_accepted',
    'inspection_passed',
  ])
  const attentionTypes = new Set([
    'variation_pending',
    'invoice_overdue',
    'milestone_overdue',
    'quote_question',
    'invoice_dispute',
  ])
  if (positiveTypes.has(eventType)) return 'green'
  if (attentionTypes.has(eventType)) return 'amber'
  return 'slate'
}
