// ─── In-memory intake state (demo / AI-only mode) ──────────────────────────────
// When Supabase is not configured, uploaded plan files and generated quotes are
// held in memory so the AI estimate pipeline can run end-to-end without a DB.
// Stored on globalThis so the state survives Next.js dev-server HMR reloads,
// matching the pattern used by the other lib/*-demo.ts modules.

import type { DemoQuote, DemoQuoteLineItem } from './quote-demo'

// ─── Types ────────────────────────────────────────────────────────────────────

export interface PendingIntakeFile {
  id: string
  job_id: string
  builder_id: string
  filename: string
  media_type: string
  /** Raw file bytes, base64-encoded for the Anthropic document API */
  base64: string
  created_at: string
}

export interface EstimateTotals {
  /** Sum of all included line item totals, ex GST */
  subtotal: number
  contingency_pct: number
  contingency_amount: number
  margin_pct: number
  margin_amount: number
  /** subtotal + contingency + margin */
  total_ex_gst: number
  gst_pct: number
  gst_amount: number
  total_inc_gst: number
}

export interface GeneratedQuoteRecord {
  quote: DemoQuote & { contingency_pct: number; gst_pct: number }
  items: DemoQuoteLineItem[]
  estimate: EstimateTotals
}

interface IntakeStore {
  files: Map<string, PendingIntakeFile>
  quotes: Map<string, GeneratedQuoteRecord>
}

// ─── Global store ─────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __workaIntakeStore: IntakeStore | undefined
}

function getStore(): IntakeStore {
  if (!globalThis.__workaIntakeStore) {
    globalThis.__workaIntakeStore = {
      files: new Map(),
      quotes: new Map(),
    }
  }
  return globalThis.__workaIntakeStore
}

// ─── File helpers ─────────────────────────────────────────────────────────────

export function storePendingFile(file: PendingIntakeFile): void {
  getStore().files.set(file.id, file)
}

export function getPendingFile(id: string): PendingIntakeFile | undefined {
  return getStore().files.get(id)
}

export function removePendingFile(id: string): void {
  getStore().files.delete(id)
}

// ─── Quote helpers ────────────────────────────────────────────────────────────

export function storeGeneratedQuote(record: GeneratedQuoteRecord): void {
  getStore().quotes.set(record.quote.id, record)
}

export function getGeneratedQuote(quoteId: string): GeneratedQuoteRecord | undefined {
  return getStore().quotes.get(quoteId)
}
