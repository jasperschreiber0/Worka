// ─── Shared in-memory comms history ─────────────────────────────────────────
// Mirrors migration 002 seed data. Mutated by the email-draft/send route.

import { randomUUID } from 'crypto'

export interface DemoCommEntry {
  id: string
  job_id: string | null
  builder_id: string
  direction: 'inbound' | 'outbound'
  channel: 'email' | 'sms' | 'chat'
  subject: string | null
  body: string
  from_address: string | null
  to_address: string | null
  timestamp: string // ISO
  linked_variation_id: string | null
  linked_invoice_id: string | null
}

// Pre-populated with seed comms matching migration 002
export const demoCommHistory: DemoCommEntry[] = [
  // Quote email to Tom Caruso (Toorak job)
  {
    id: '00000000-0000-0000-0000-000000000071',
    job_id: '00000000-0000-0000-0000-000000000020',
    builder_id: '00000000-0000-0000-0000-000000000001',
    direction: 'outbound',
    channel: 'email',
    subject: 'Quote — 8 Burnside Rd, Toorak',
    body: 'Hi Tom, please find your quote attached for the work at 8 Burnside Rd. Total: $127,500. Happy to discuss further.\n\nDave Nguyen\nNguyen Constructions',
    from_address: 'dave@nguyenconstructions.com.au',
    to_address: 'tom.caruso@example.com',
    timestamp: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000).toISOString(),
    linked_variation_id: null,
    linked_invoice_id: null,
  },
  // Invoice email to Hendersons (Fitzroy job)
  {
    id: '00000000-0000-0000-0000-000000000072',
    job_id: '00000000-0000-0000-0000-000000000010',
    builder_id: '00000000-0000-0000-0000-000000000001',
    direction: 'outbound',
    channel: 'email',
    subject: 'Invoice — 14 Merri St, Fitzroy',
    body: 'Hi, please find your invoice attached for the work completed at 14 Merri St, Fitzroy. Total: $28,000. Due date: 7 days from receipt.\n\nDave Nguyen\nNguyen Constructions',
    from_address: 'dave@nguyenconstructions.com.au',
    to_address: 'henderson@example.com',
    timestamp: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
    linked_variation_id: null,
    linked_invoice_id: '00000000-0000-0000-0000-000000000061',
  },
  // VAR-001 notification to Hendersons
  {
    id: '00000000-0000-0000-0000-000000000073',
    job_id: '00000000-0000-0000-0000-000000000010',
    builder_id: '00000000-0000-0000-0000-000000000001',
    direction: 'outbound',
    channel: 'email',
    subject: 'Variation request — kitchen benchtop upgrade',
    body: 'Hi, we have a variation request for your approval: upgrade kitchen benchtop to 40mm Caesarstone. Amount: $3,200.\n\nDave Nguyen\nNguyen Constructions',
    from_address: 'dave@nguyenconstructions.com.au',
    to_address: 'henderson@example.com',
    timestamp: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
    linked_variation_id: 'var-001',
    linked_invoice_id: null,
  },
  // VAR-002 notification to Hendersons
  {
    id: '00000000-0000-0000-0000-000000000074',
    job_id: '00000000-0000-0000-0000-000000000010',
    builder_id: '00000000-0000-0000-0000-000000000001',
    direction: 'outbound',
    channel: 'email',
    subject: 'Variation request — additional GPO points',
    body: 'Hi, we have a variation request for your approval: add extra GPO points to the living room. Amount: $680.\n\nDave Nguyen\nNguyen Constructions',
    from_address: 'dave@nguyenconstructions.com.au',
    to_address: 'henderson@example.com',
    timestamp: new Date(Date.now() - 4 * 24 * 60 * 60 * 1000).toISOString(),
    linked_variation_id: 'var-002',
    linked_invoice_id: null,
  },
]

export function addCommEntry(
  entry: Omit<DemoCommEntry, 'id' | 'timestamp'>
): DemoCommEntry {
  const newEntry: DemoCommEntry = {
    ...entry,
    id: randomUUID(),
    timestamp: new Date().toISOString(),
  }
  demoCommHistory.push(newEntry)
  return newEntry
}
