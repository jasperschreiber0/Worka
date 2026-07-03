import { NextRequest, NextResponse } from 'next/server'
import type { ProjectMetadata, SimilarProject } from '@/lib/types/estimation.types'
import { DEMO_PROJECT_MEMORY } from '@/lib/estimation-demo'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── Similarity scoring (structured matching — no embeddings required) ────────

function scoreProject(candidate: SimilarProject, query: ProjectMetadata): { score: number; reasons: string[] } {
  let score = 0
  const reasons: string[] = []

  // Job type (30pts)
  if (candidate.job_type && candidate.job_type === query.job_type) {
    score += 30
    reasons.push('Same job type')
  } else if (candidate.job_type && query.job_type) {
    // Partial credit for related types
    const related: Record<string, string[]> = {
      rear_extension: ['side_extension', 'full_renovation'],
      side_extension: ['rear_extension'],
      full_renovation: ['rear_extension', 'kitchen_reno', 'bathroom_reno'],
    }
    if (related[query.job_type]?.includes(candidate.job_type)) {
      score += 12
      reasons.push('Related job type')
    }
  }

  // Floor area (20pts)
  if (candidate.floor_area_m2 && query.floor_area_m2) {
    const pctDiff = Math.abs(candidate.floor_area_m2 - query.floor_area_m2) / query.floor_area_m2
    if (pctDiff < 0.1) { score += 20; reasons.push('Very similar floor area') }
    else if (pctDiff < 0.2) { score += 15; reasons.push(`Similar floor area (${pctDiff > 0 ? '+' : ''}${Math.round(pctDiff * 100)}%)`) }
    else if (pctDiff < 0.35) { score += 8; reasons.push(`Floor area within 35%`) }
  }

  // Region (15pts)
  if (candidate.region && candidate.region === query.region) {
    score += 15; reasons.push('Same state')
  } else if (candidate.region && query.region) {
    score += 4; reasons.push('Different state')
  }

  // Finish level (15pts)
  if (candidate.finish_level === query.finish_level) {
    score += 15; reasons.push('Same finish level')
  } else if (candidate.finish_level && query.finish_level) {
    const levels = ['budget', 'standard', 'premium', 'luxury']
    const diff = Math.abs(levels.indexOf(candidate.finish_level) - levels.indexOf(query.finish_level))
    if (diff === 1) { score += 8; reasons.push('Adjacent finish level') }
  }

  // Wet areas (10pts)
  if (candidate.wet_areas !== null && query.wet_areas !== null) {
    const diff = Math.abs((candidate.wet_areas ?? 0) - (query.wet_areas ?? 0))
    if (diff === 0) { score += 10; reasons.push('Same wet area count') }
    else if (diff === 1) { score += 5; reasons.push('Wet areas within 1') }
  }

  // Storeys (10pts)
  if (candidate.storeys !== null && query.storeys !== null) {
    if (candidate.storeys === query.storeys) { score += 10; reasons.push('Same number of storeys') }
  }

  return { score: Math.min(score, 100), reasons }
}

// ─── POST /api/estimation/similar-jobs ────────────────────────────────────────

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: { project_metadata: ProjectMetadata; builder_id: string; limit?: number }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { project_metadata, limit = 5 } = body
  if (!project_metadata) {
    return NextResponse.json({ error: 'project_metadata required' }, { status: 400 })
  }

  const isDemo = !process.env.NEXT_PUBLIC_SUPABASE_URL

  if (isDemo) {
    const scored = DEMO_PROJECT_MEMORY
      .map(p => {
        const { score, reasons } = scoreProject(p, project_metadata)
        return { ...p, similarity_score: score, similarity_reasons: reasons }
      })
      .filter(p => p.similarity_score >= 50)
      .sort((a, b) => b.similarity_score - a.similarity_score)
      .slice(0, limit)

    return NextResponse.json({ similar_projects: scored, total_in_memory: DEMO_PROJECT_MEMORY.length })
  }

  // Live mode: query project_memory table
  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    // Fetch all completed / active projects for this builder
    const { data: projects } = await supabase
      .from('project_memory')
      .select('*')
      .eq('builder_id', builder_id)
      .in('status', ['completed', 'active'])
      .order('completed_at', { ascending: false })
      .limit(100)

    const scored = (projects ?? [])
      .map((p: SimilarProject) => {
        const { score, reasons } = scoreProject(p, project_metadata)
        return { ...p, similarity_score: score, similarity_reasons: reasons }
      })
      .filter((p: SimilarProject & { similarity_score: number }) => p.similarity_score >= 50)
      .sort((a: { similarity_score: number }, b: { similarity_score: number }) => b.similarity_score - a.similarity_score)
      .slice(0, limit)

    return NextResponse.json({ similar_projects: scored, total_in_memory: projects?.length ?? 0 })
  } catch (err) {
    console.error('[similar-jobs]', err)
    return NextResponse.json({ similar_projects: [], total_in_memory: 0 })
  }
}
