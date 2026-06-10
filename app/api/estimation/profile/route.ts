import { NextRequest, NextResponse } from 'next/server'
import type { BuilderEstimationProfile } from '@/lib/types/estimation.types'
import { DEMO_BUILDER_PROFILE } from '@/lib/estimation-demo'

// ─── GET /api/estimation/profile?builder_id=xxx ───────────────────────────────

export async function GET(request: NextRequest): Promise<NextResponse> {
  const builderId = request.nextUrl.searchParams.get('builder_id')
  if (!builderId) return NextResponse.json({ error: 'builder_id required' }, { status: 400 })

  const isDemo = !process.env.NEXT_PUBLIC_SUPABASE_URL
  if (isDemo) {
    return NextResponse.json({ profile: DEMO_BUILDER_PROFILE })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data } = await supabase
      .from('builder_estimation_profiles')
      .select('*')
      .eq('builder_id', builderId)
      .single()

    if (!data) {
      // No profile yet — return defaults
      const defaults: BuilderEstimationProfile = {
        builder_id: builderId,
        typical_margin_pct: 20,
        typical_contingency_pct: 5,
        finish_level: 'standard',
        avg_adjustment_pct: null,
        adjustment_direction: null,
        quotes_generated: 0,
        jobs_completed: 0,
        avg_quote_accuracy_pct: null,
        preferred_suppliers: [],
      }
      return NextResponse.json({ profile: defaults })
    }

    return NextResponse.json({ profile: data as BuilderEstimationProfile })
  } catch (err) {
    console.error('[estimation/profile]', err)
    return NextResponse.json({ profile: DEMO_BUILDER_PROFILE })
  }
}

// ─── PATCH /api/estimation/profile — update profile after quote adjustment ────

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  let body: Partial<BuilderEstimationProfile> & { builder_id: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const { builder_id, ...updates } = body
  if (!builder_id) return NextResponse.json({ error: 'builder_id required' }, { status: 400 })

  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return NextResponse.json({ ok: true, demo: true })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    await supabase
      .from('builder_estimation_profiles')
      .upsert({ builder_id, ...updates, updated_at: new Date().toISOString() }, { onConflict: 'builder_id' })

    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[estimation/profile PATCH]', err)
    return NextResponse.json({ error: 'Update failed' }, { status: 500 })
  }
}
