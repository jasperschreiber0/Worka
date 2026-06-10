// ─── In-memory store for AI-generated quotes (no-Supabase mode) ─────────────────
// When Supabase is not configured, the intake pipeline stores the generated
// estimate here so /api/quotes/[quoteId] can serve it. Module-level singleton on
// globalThis so it survives Next.js dev HMR reloads — uploaded file bytes are
// handled separately by lib/file-cache.ts.

import type { DemoQuote, DemoQuoteLineItem } from './quote-demo'

// ─── Types ────────────────────────────────────────────────────────────────────

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

// ─── Global store ─────────────────────────────────────────────────────────────

declare global {
  // eslint-disable-next-line no-var
  var __workaGeneratedQuotes: Map<string, GeneratedQuoteRecord> | undefined
}

function getStore(): Map<string, GeneratedQuoteRecord> {
  if (!globalThis.__workaGeneratedQuotes) {
    globalThis.__workaGeneratedQuotes = new Map()
  }
  return globalThis.__workaGeneratedQuotes
}

export function storeGeneratedQuote(record: GeneratedQuoteRecord): void {
  getStore().set(record.quote.id, record)
}

export function getGeneratedQuote(quoteId: string): GeneratedQuoteRecord | undefined {
  return getStore().get(quoteId)
}
