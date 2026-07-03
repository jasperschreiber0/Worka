import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { DEMO_ASSUMPTIONS, demoResolutionState } from '@/lib/assumptions-demo'
import type { AssumptionItem } from '@/lib/assumptions-demo'

// Re-export type so components can import it from here if needed
export type { AssumptionItem }

// ─── Response shape ────────────────────────────────────────────────────────────

interface AssumptionsResponse {
  quote_id: string
  assumptions: AssumptionItem[]
  total_count: number
  unresolved_count: number
}

// ─── GET /api/assumptions/[quoteId] ──────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { quoteId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { quoteId } = params

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isRealMode = Boolean(supabaseUrl && supabaseKey)

  // ── Demo mode ──────────────────────────────────────────────────────────────
  if (!isRealMode || quoteId === 'demo-quote-id') {
    // Merge in any in-memory resolutions
    const assumptions: AssumptionItem[] = DEMO_ASSUMPTIONS.map((a) => {
      const override = demoResolutionState.get(a.id)
      if (!override) return a
      return {
        ...a,
        resolution_type: override.resolution_type,
        current_quantity:
          override.adjusted_quantity !== undefined
            ? override.adjusted_quantity
            : a.current_quantity,
        current_unit:
          override.adjusted_unit !== undefined ? override.adjusted_unit : a.current_unit,
      }
    })

    const total_count = assumptions.length
    const unresolved_count = assumptions.filter(
      (a) => a.resolution_type === 'unresolved'
    ).length

    const response: AssumptionsResponse = {
      quote_id: quoteId,
      assumptions,
      total_count,
      unresolved_count,
    }

    return NextResponse.json(response)
  }

  // ── Real mode: Supabase ───────────────────────────────────────────────────
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(supabaseUrl!, supabaseKey!)

    // The quote must belong to the authenticated builder
    const { data: ownedQuote } = await supabase
      .from('quotes')
      .select('id')
      .eq('id', quoteId)
      .eq('builder_id', builderId)
      .single()
    if (!ownedQuote) {
      return NextResponse.json({ error: 'Quote not found' }, { status: 404 })
    }

    // Fetch assumptions with linked line item and trade category
    const { data: rows, error } = await supabase
      .from('assumptions')
      .select(
        `
        id,
        line_item_id,
        description,
        resolution_type,
        quote_line_items (
          quantity,
          unit,
          rate,
          is_assumption,
          assumption_status,
          dimensions_string,
          trade_categories (
            name
          )
        )
      `
      )
      .eq('quote_id', quoteId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    if (!rows) {
      return NextResponse.json(
        { quote_id: quoteId, assumptions: [], total_count: 0, unresolved_count: 0 },
        { status: 200 }
      )
    }

    // Map rows to AssumptionItem shape — infer gate from line item state
    const assumptions: AssumptionItem[] = rows.map((row) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const li = (row as any).quote_line_items as {
        quantity: number | null
        unit: string | null
        rate: number | null
        dimensions_string: string | null
        assumption_status: string | null
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        trade_categories: any
      } | null

      const tradeName: string = li?.trade_categories?.name ?? 'Unknown'

      // Infer gate from line item state
      let gate: 1 | 2 | 3 = 2
      if (!li?.unit) {
        gate = 1
      } else if (li?.quantity !== null && li?.quantity !== undefined && li.quantity <= 0) {
        gate = 3
      } else if (!li?.dimensions_string) {
        gate = 2
      }

      const resolutionType = (row.resolution_type ?? 'unresolved') as
        | 'unresolved'
        | 'accepted'
        | 'adjusted'
        | 'excluded'

      return {
        id: row.id,
        line_item_id: row.line_item_id ?? null,
        description: row.description,
        gate,
        current_quantity: li?.quantity ?? null,
        current_unit: li?.unit ?? null,
        current_rate: li?.rate ?? null,
        trade_category: tradeName,
        resolution_type: resolutionType,
      }
    })

    const total_count = assumptions.length
    const unresolved_count = assumptions.filter(
      (a) => a.resolution_type === 'unresolved'
    ).length

    const response: AssumptionsResponse = {
      quote_id: quoteId,
      assumptions,
      total_count,
      unresolved_count,
    }

    return NextResponse.json(response)
  } catch (err) {
    console.error('Assumptions GET error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
