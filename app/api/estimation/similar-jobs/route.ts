import { NextRequest, NextResponse } from 'next/server'
import type { ProjectMetadata, SimilarProject } from '@/lib/types/estimation.types'
import { DEMO_PROJECT_MEMORY } from '@/lib/estimation-demo'
import { scoreProject } from '@/lib/estimation-engine'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

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

  const isDemo = isDemoMode()

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
