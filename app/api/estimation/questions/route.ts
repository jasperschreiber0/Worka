import { NextRequest, NextResponse } from 'next/server'
import { isDemoMode, getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { buildAssessmentRunner } from '@/lib/assessment/runner'
import { createRepositories } from '@/lib/repositories'

export const dynamic = 'force-dynamic'

// ─── /api/estimation/questions ────────────────────────────────────────────────
// Thin orchestration adapter over the AssessmentRunner. GET is a read-only query
// against the repositories; POST maps answer/skip/complete onto AssessmentInput
// and shapes the runner's result back into the response the existing
// ClarifyingQuestions UI expects.

// ── GET ?job_id= — list questions + clarification state ──────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mode: 'demo' | 'real' = isDemoMode() ? 'demo' : 'real'
  const jobId = new URL(req.url).searchParams.get('job_id') ?? 'demo-job'

  try {
    const repos = createRepositories(mode)
    const [questions, scope] = await Promise.all([
      repos.openQuestions.listForJob(builderId, jobId),
      repos.projectScope.get(builderId, jobId),
    ])
    return NextResponse.json({
      questions,
      clarification_status: scope?.clarificationStatus ?? 'pending',
      is_indicative: scope?.isIndicative ?? true,
      recommended_estimate_type: scope?.recommendedEstimateType ?? 'Budget/Preliminary',
    })
  } catch (err) {
    console.error('[questions:get]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not load questions.' }, { status: 500 })
  }
}

// ── POST — answer | skip | complete ──────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { action?: 'answer' | 'skip' | 'complete'; job_id?: string; question_id?: string; answer?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const action = body.action
  if (action !== 'answer' && action !== 'skip' && action !== 'complete') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  const mode: 'demo' | 'real' = isDemoMode() ? 'demo' : 'real'
  const jobId = body.job_id ?? 'demo-job'

  if (mode === 'real' && action === 'answer' && !body.question_id) {
    return NextResponse.json({ error: 'question_id required' }, { status: 400 })
  }

  try {
    const runner = buildAssessmentRunner(mode)
    const ctx = { builderId, mode }

    if (action === 'answer') {
      await runner.run(
        { kind: 'answer_question', jobId, questionId: body.question_id ?? '', answer: body.answer ?? '' },
        ctx
      )
      return NextResponse.json({ ok: true })
    }

    const result = await runner.run(
      { kind: action === 'skip' ? 'skip_questions' : 'complete_questions', jobId },
      ctx
    )
    if (result.stage !== 'scoping') return NextResponse.json({ error: 'Unexpected stage' }, { status: 500 })

    return NextResponse.json({
      ok: true,
      clarification_status: result.data.clarificationStatus,
      is_indicative: result.isIndicative,
    })
  } catch (err) {
    console.error('[questions:post]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not update questions.' }, { status: 500 })
  }
}
