import { NextRequest, NextResponse } from 'next/server'
import type { CostReconciliationEntry } from '@/lib/types/estimation.types'

interface ReconcilePayload {
  job_id: string
  builder_id: string
  quote_id: string
  entries: CostReconciliationEntry[]
  final_cost?: number
  final_margin_pct?: number
}

// ─── POST /api/estimation/reconcile ──────────────────────────────────────────
// Records actual costs against estimated costs for a completed job.
// This is the core learning feedback loop.

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: ReconcilePayload
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { job_id, builder_id, quote_id, entries, final_cost, final_margin_pct } = body
  if (!job_id || !builder_id || !entries?.length) {
    return NextResponse.json({ error: 'job_id, builder_id, and entries required' }, { status: 400 })
  }

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ ok: true, demo: true, message: 'Reconciliation logged (demo mode)' })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Upsert project_memory record to completed status
    const { data: memoryRow } = await supabase
      .from('project_memory')
      .upsert({
        job_id,
        builder_id,
        quote_id,
        status: 'completed',
        final_cost,
        final_margin_pct,
        completed_at: new Date().toISOString(),
      }, { onConflict: 'job_id' })
      .select()
      .single()

    if (memoryRow) {
      // Insert reconciliation rows
      const reconciliationInserts = entries
        .filter(e => e.actual_cost !== null)
        .map(e => ({
          project_memory_id: memoryRow.id,
          builder_id,
          trade_category_id: e.trade_category_id,
          estimated_cost: e.estimated_cost,
          actual_cost: e.actual_cost,
          recorded_at: new Date().toISOString(),
        }))

      if (reconciliationInserts.length > 0) {
        await supabase.from('cost_reconciliation').insert(reconciliationInserts)
      }

      // Update builder profile accuracy metrics
      const totalEstimated = entries.reduce((s, e) => s + e.estimated_cost, 0)
      const totalActual = entries.reduce((s, e) => s + (e.actual_cost ?? e.estimated_cost), 0)
      const accuracyPct = totalEstimated > 0
        ? Math.max(0, 100 - Math.abs((totalActual - totalEstimated) / totalEstimated * 100))
        : null

      if (accuracyPct !== null) {
        // Increment jobs_completed and update running accuracy
        const { data: profile } = await supabase
          .from('builder_estimation_profiles')
          .select('jobs_completed, avg_quote_accuracy_pct')
          .eq('builder_id', builder_id)
          .single()

        const prevCount = profile?.jobs_completed ?? 0
        const prevAccuracy = profile?.avg_quote_accuracy_pct ?? accuracyPct
        const newAccuracy = (prevAccuracy * prevCount + accuracyPct) / (prevCount + 1)

        await supabase
          .from('builder_estimation_profiles')
          .upsert({
            builder_id,
            jobs_completed: prevCount + 1,
            avg_quote_accuracy_pct: Math.round(newAccuracy * 10) / 10,
            updated_at: new Date().toISOString(),
          }, { onConflict: 'builder_id' })
      }
    }

    return NextResponse.json({ ok: true, message: 'Actual costs recorded. Estimation memory updated.' })
  } catch (err) {
    console.error('[estimation/reconcile]', err)
    return NextResponse.json({ error: 'Reconciliation failed' }, { status: 500 })
  }
}

// ─── GET /api/estimation/reconcile?builder_id=x&trade_category_id=y ──────────
// Returns historical variance data for a trade category.

export async function GET(request: NextRequest): Promise<NextResponse> {
  const builderId = request.nextUrl.searchParams.get('builder_id')
  const tradeCategoryId = request.nextUrl.searchParams.get('trade_category_id')

  if (!builderId) return NextResponse.json({ error: 'builder_id required' }, { status: 400 })

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    // Return demo variance data
    const { DEMO_TRADE_VARIANCES } = await import('@/lib/estimation-demo')
    const filtered = tradeCategoryId
      ? DEMO_TRADE_VARIANCES.filter(v => v.trade_category_id === parseInt(tradeCategoryId))
      : DEMO_TRADE_VARIANCES
    return NextResponse.json({ variances: filtered, demo: true })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    let query = supabase
      .from('cost_reconciliation')
      .select('trade_category_id, estimated_cost, actual_cost')
      .eq('builder_id', builderId)
      .not('actual_cost', 'is', null)

    if (tradeCategoryId) {
      query = query.eq('trade_category_id', parseInt(tradeCategoryId))
    }

    const { data } = await query

    // Aggregate variance by trade category
    const byTrade = new Map<number, { total_estimated: number; total_actual: number; count: number }>()
    for (const row of (data ?? [])) {
      const existing = byTrade.get(row.trade_category_id) ?? { total_estimated: 0, total_actual: 0, count: 0 }
      existing.total_estimated += row.estimated_cost
      existing.total_actual += row.actual_cost
      existing.count++
      byTrade.set(row.trade_category_id, existing)
    }

    const variances = Array.from(byTrade.entries()).map(([id, v]) => ({
      trade_category_id: id,
      avg_variance_pct: v.total_estimated > 0
        ? Math.round((v.total_actual - v.total_estimated) / v.total_estimated * 1000) / 10
        : 0,
      sample_count: v.count,
    }))

    return NextResponse.json({ variances })
  } catch (err) {
    console.error('[estimation/reconcile GET]', err)
    return NextResponse.json({ variances: [] })
  }
}
