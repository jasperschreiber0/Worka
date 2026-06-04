// ─── In-memory rate store for demo mode ──────────────────────────────────────

export interface ImportedRate {
  id: string
  trade_category_id: number
  trade_category_name: string
  description: string
  unit: string
  rate: number
  supplier_name: string
  imported_at: string
}

export const demoImportedRates: ImportedRate[] = []
