import { NextRequest, NextResponse } from 'next/server'
import type { ProjectMetadata, SimilarProject } from '@/lib/types/estimation.types'
import { DEMO_PROJECT_MEMORY, DEMO_BUILDER_PROFILE } from '@/lib/estimation-demo'
import { scoreProject, estimateFromComparables } from '@/lib/estimation-engine'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── POST /api/estimation/quick-estimate ─────────────────────────────────────
// Parametric estimate from the builder's own history. Input: high-level job
// parameters. Output: a grounded client price, cost, range, confidence,
// per-trade breakdown, and the comparable jobs that drove it.

const DEFAULT_MARGIN_PCT = 18

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { project_metadata: Partial<ProjectMetadata> }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const pm = body.project_metadata ?? {}
  const query: ProjectMetadata = {
    job_type: pm.job_type ?? null,
    renovation_type: pm.renovation_type ?? null,
    project_summary: pm.project_summary ?? '',
    floor_area_m2: pm.floor_area_m2 ?? null,
    storeys: pm.storeys ?? null,
    wet_areas: pm.wet_areas ?? null,
    bedrooms: pm.bedrooms ?? null,
    finish_level: pm.finish_level ?? null,
    construction_type: pm.construction_type ?? null,
    region: pm.region ?? null,
    suburb: pm.suburb ?? null,
  }

  const isDemo = !process.env.NEXT_PUBLIC_SUPABASE_URL

  // ── Gather comparables + margin ─────────────────────────────────────────────
  let comparables: SimilarProject[] = []
  let marginPct = DEFAULT_MARGIN_PCT
  let totalInMemory = 0

  if (isDemo) {
    marginPct = DEMO_BUILDER_PROFILE.typical_margin_pct
    totalInMemory = DEMO_PROJECT_MEMORY.length
    comparables = DEMO_PROJECT_MEMORY
      .map((p) => {
        const { score, reasons } = scoreProject(p, query)
        return { ...p, similarity_score: score, similarity_reasons: reasons }
      })
      .filter((p) => p.similarity_score >= 50)
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .slice(0, 6)
  } else {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!
      )

      const [{ data: projects }, { data: profile }] = await Promise.all([
        supabase
          .from('project_memory')
          .select('*')
          .eq('builder_id', builderId)
          .in('status', ['completed', 'active'])
          .order('completed_at', { ascending: false })
          .limit(100),
        supabase
          .from('builder_estimation_profiles')
          .select('typical_margin_pct')
          .eq('builder_id', builderId)
          .maybeSingle(),
      ])

      marginPct = profile?.typical_margin_pct ?? DEFAULT_MARGIN_PCT
      totalInMemory = projects?.length ?? 0
      comparables = (projects ?? [])
        .map((p: SimilarProject) => {
          const { score, reasons } = scoreProject(p, query)
          return { ...p, similarity_score: score, similarity_reasons: reasons }
        })
        .filter((p: SimilarProject) => p.similarity_score >= 50)
        .sort((a: SimilarProject, b: SimilarProject) => b.similarity_score - a.similarity_score)
        .slice(0, 6)
    } catch (err) {
      console.error('[quick-estimate]', err)
      return NextResponse.json(
        { error: 'Could not load your project history. Please try again.' },
        { status: 500 }
      )
    }
  }

  const estimate = estimateFromComparables(query, comparables, marginPct)
  return NextResponse.json({ estimate, total_in_memory: totalInMemory, demo: isDemo })
}
