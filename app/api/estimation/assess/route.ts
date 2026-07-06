import { NextRequest, NextResponse } from 'next/server'
import { isDemoMode, getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { buildAssessmentRunner } from '@/lib/assessment/runner'
import { createRepositories } from '@/lib/repositories'
import type { StatedPurpose } from '@/lib/estimation-reasoning'

// Node runtime — the runner's real-mode LLM calls need headroom.
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ─── POST /api/estimation/assess ──────────────────────────────────────────────
// Thin orchestration adapter: auth → build AssessmentInput → runner.run() →
// shape the response. All extraction/classification/reasoning/persistence logic
// lives in lib/assessment + lib/services + lib/repositories.

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { job_id?: string; file_ids?: string[]; stated_purpose?: StatedPurpose }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mode: 'demo' | 'real' = isDemoMode() ? 'demo' : 'real'
  const jobId = body.job_id ?? 'demo-job'

  if (mode === 'real' && (!Array.isArray(body.file_ids) || body.file_ids.length === 0)) {
    return NextResponse.json({ error: 'No file_ids supplied' }, { status: 400 })
  }

  try {
    const runner = buildAssessmentRunner(mode)
    const result = await runner.run(
      { kind: 'upload', fileIds: body.file_ids ?? [], jobId },
      { builderId, mode }
    )
    if (result.stage !== 'scoping') {
      return NextResponse.json({ error: 'Unexpected assessment stage' }, { status: 500 })
    }
    return NextResponse.json({
      assessment: toLegacyAssessment(jobId, result, mode === 'demo'),
      demo: mode === 'demo',
    })
  } catch (err) {
    console.error('[assess:error]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not assess the documents. Please try again.' }, { status: 500 })
  }
}

// ─── GET /api/estimation/assess?job_id= ───────────────────────────────────────
// Read-only — queries the repositories directly (no assessment to "advance").

export async function GET(req: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mode: 'demo' | 'real' = isDemoMode() ? 'demo' : 'real'
  const jobId = new URL(req.url).searchParams.get('job_id') ?? 'demo-job'

  try {
    const repos = createRepositories(mode)
    const [documents, scope, questions] = await Promise.all([
      repos.documents.listForJob(builderId, jobId),
      repos.projectScope.get(builderId, jobId),
      repos.openQuestions.listForJob(builderId, jobId),
    ])
    if (!scope) return NextResponse.json({ assessment: mode === 'demo' ? null : null, demo: mode === 'demo' })

    return NextResponse.json({
      assessment: {
        job_id: jobId,
        demo: mode === 'demo',
        generated_at: new Date().toISOString(),
        documents,
        scope: scope.scope,
        open_questions: questions.map((q) => ({ group: q.group, question: q.question, source_reference: q.source_reference })),
      },
      demo: mode === 'demo',
    })
  } catch (err) {
    console.error('[assess:get]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not load the assessment.' }, { status: 500 })
  }
}

// ─── legacy shape adapter ──────────────────────────────────────────────────────
// The existing ProjectAssessmentCard/page expect { job_id, documents, scope,
// open_questions, generated_at, demo } — map the contract's scoping result onto
// that shape so the UI built in Stages 1-2 needs no changes.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function toLegacyAssessment(jobId: string, result: any, demo: boolean) {
  return {
    job_id: jobId,
    demo,
    generated_at: new Date().toISOString(),
    documents: result.data.documents,
    scope: result.data.scope,
    open_questions: result.data.questions.map((q: { group: string; question: string; source_reference: string | null }) => ({
      group: q.group,
      question: q.question,
      source_reference: q.source_reference,
    })),
  }
}
