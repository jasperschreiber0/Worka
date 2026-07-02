import { NextRequest, NextResponse } from 'next/server'

// ─── GET /api/cron/network-rates ─────────────────────────────────────────────
// Scheduled nightly by Vercel Cron (see vercel.json). Recomputes Tier 5 of the
// rate hierarchy: anonymised P25/P50/P75 of builder_learned_rates across all
// builders, per line_item_key — one national row plus one row per state.
//
// Anonymity guard: an aggregate is only written when at least MIN_SAMPLES
// distinct builders contribute, so no single builder's rate is ever exposed.
//
// Auth: Vercel sends `Authorization: Bearer ${CRON_SECRET}` automatically
// when the CRON_SECRET env var is set on the project.

export const dynamic = 'force-dynamic'

const MIN_SAMPLES = 3

interface LearnedRateRow {
  line_item_key: string
  rate: number
  unit: string
  builder_id: string
  builders: { state: string | null } | null
}

function percentile(sorted: number[], q: number): number {
  if (sorted.length === 1) return sorted[0]
  const pos = (sorted.length - 1) * q
  const lower = Math.floor(pos)
  const upper = Math.ceil(pos)
  const weight = pos - lower
  const value = sorted[lower] + (sorted[upper] - sorted[lower]) * weight
  return Math.round(value * 100) / 100
}

interface Aggregate {
  line_item_key: string
  state: string | null
  rate_p25: number
  rate_p50: number
  rate_p75: number
  sample_count: number
}

function aggregate(key: string, state: string | null, rates: number[]): Aggregate {
  const sorted = [...rates].sort((a, b) => a - b)
  return {
    line_item_key: key,
    state,
    rate_p25: percentile(sorted, 0.25),
    rate_p50: percentile(sorted, 0.5),
    rate_p75: percentile(sorted, 0.75),
    sample_count: sorted.length,
  }
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  // ── Auth guard ─────────────────────────────────────────────────────────────
  const cronSecret = process.env.CRON_SECRET
  if (cronSecret && request.headers.get('authorization') !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ aggregated: 0, skipped: 'demo mode — no Supabase configured' })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: rows, error } = await supabase
      .from('builder_learned_rates')
      .select('line_item_key, rate, unit, builder_id, builders ( state )')

    if (error) {
      console.error('[cron/network-rates] fetch failed:', error.message)
      return NextResponse.json({ error: 'Failed to read learned rates' }, { status: 500 })
    }

    const learned = (rows ?? []) as unknown as LearnedRateRow[]

    // Group rates per key nationally and per key+state
    const national = new Map<string, number[]>()
    const byState = new Map<string, number[]>() // "key|state"

    for (const row of learned) {
      const list = national.get(row.line_item_key) ?? []
      list.push(row.rate)
      national.set(row.line_item_key, list)

      const state = row.builders?.state ?? null
      if (state) {
        const stateKey = `${row.line_item_key}|${state}`
        const stateList = byState.get(stateKey) ?? []
        stateList.push(row.rate)
        byState.set(stateKey, stateList)
      }
    }

    const aggregates: Aggregate[] = []

    national.forEach((rates, key) => {
      if (rates.length >= MIN_SAMPLES) aggregates.push(aggregate(key, null, rates))
    })
    byState.forEach((rates, compound) => {
      if (rates.length >= MIN_SAMPLES) {
        const [key, state] = compound.split('|')
        aggregates.push(aggregate(key, state, rates))
      }
    })

    const now = new Date().toISOString()
    let written = 0

    // State-scoped rows can use upsert on the (line_item_key, state) constraint.
    // National rows have state = NULL, which never conflicts in Postgres, so
    // they need an explicit lookup-then-write.
    for (const agg of aggregates) {
      if (agg.state !== null) {
        const { error: upsertErr } = await supabase
          .from('network_rate_aggregates')
          .upsert({ ...agg, updated_at: now }, { onConflict: 'line_item_key,state' })
        if (!upsertErr) written++
        continue
      }

      const { data: existing } = await supabase
        .from('network_rate_aggregates')
        .select('id')
        .eq('line_item_key', agg.line_item_key)
        .is('state', null)
        .maybeSingle()

      if (existing) {
        const { error: updateErr } = await supabase
          .from('network_rate_aggregates')
          .update({ ...agg, updated_at: now })
          .eq('id', existing.id)
        if (!updateErr) written++
      } else {
        const { error: insertErr } = await supabase
          .from('network_rate_aggregates')
          .insert({ ...agg, updated_at: now })
        if (!insertErr) written++
      }
    }

    return NextResponse.json({
      aggregated: written,
      candidates: aggregates.length,
      learned_rate_rows: learned.length,
    })
  } catch (err) {
    console.error('[cron/network-rates] error:', err)
    return NextResponse.json({ error: 'Aggregation failed' }, { status: 500 })
  }
}
