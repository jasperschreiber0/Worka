import { NextRequest, NextResponse } from 'next/server'
import { isDemoMode, getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { DEMO_ASSESSMENT } from '@/lib/estimation-assessment-demo'
import {
  ESSENTIAL_QUESTION_GROUPS,
  computeIsIndicative,
  type ClarificationStatus,
  type OpenQuestion,
  type EstimateType,
} from '@/lib/estimation-reasoning'

export const dynamic = 'force-dynamic'

// ─── /api/estimation/questions ────────────────────────────────────────────────
// The clarifying-questions step. Builders answer essential open questions inline
// or skip to an indicative estimate. Skipping (or unresolved essential gaps)
// forces project_scope.is_indicative, which watermarks every downstream output.

interface QuestionState {
  questions: Array<OpenQuestion & { id: string; resolved: boolean; answer: string | null }>
  clarification_status: ClarificationStatus
  is_indicative: boolean
  recommended_estimate_type: EstimateType
}

// ── GET ?job_id= — list questions + clarification state ──────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const jobId = new URL(req.url).searchParams.get('job_id')

  if (isDemoMode()) {
    const state: QuestionState = {
      questions: DEMO_ASSESSMENT.open_questions.map((q, i) => ({
        ...q,
        id: `demo-q-${i}`,
        resolved: false,
        answer: null,
      })),
      clarification_status: 'pending',
      is_indicative: true,
      recommended_estimate_type: DEMO_ASSESSMENT.scope.recommended_estimate_type,
    }
    return NextResponse.json(state)
  }

  if (!jobId) return NextResponse.json({ error: 'job_id required' }, { status: 400 })

  try {
    const supabase = await admin()
    const [{ data: qRows }, { data: scopeRow }] = await Promise.all([
      supabase.from('open_questions').select('*').eq('builder_id', builderId).eq('job_id', jobId).order('created_at'),
      supabase.from('project_scope').select('clarification_status, is_indicative, recommended_estimate_type').eq('builder_id', builderId).eq('job_id', jobId).maybeSingle(),
    ])

    const state: QuestionState = {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      questions: (qRows ?? []).map((q: any) => ({
        id: q.id,
        group: q.question_group,
        question: q.question_text,
        source_reference: q.source_reference ?? null,
        resolved: Boolean(q.resolved),
        answer: q.answer ?? null,
      })),
      clarification_status: (scopeRow?.clarification_status as ClarificationStatus) ?? 'pending',
      is_indicative: scopeRow?.is_indicative ?? true,
      recommended_estimate_type: (scopeRow?.recommended_estimate_type as EstimateType) ?? 'Budget/Preliminary',
    }
    return NextResponse.json(state)
  } catch (err) {
    console.error('[questions:get]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not load questions.' }, { status: 500 })
  }
}

// ── POST — answer | skip | complete ──────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: {
    action?: 'answer' | 'skip' | 'complete'
    job_id?: string
    question_id?: string
    answer?: string
  }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  const action = body.action
  if (action !== 'answer' && action !== 'skip' && action !== 'complete') {
    return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
  }

  // ── Demo mode — answers are held in the client; report the resulting state ──
  if (isDemoMode()) {
    const recommended = DEMO_ASSESSMENT.scope.recommended_estimate_type
    if (action === 'answer') return NextResponse.json({ ok: true })
    const clarification_status: ClarificationStatus = action === 'skip' ? 'skipped' : 'answered'
    const is_indicative = computeIsIndicative({
      clarificationStatus: clarification_status,
      recommendedEstimateType: recommended,
      // Demo doesn't persist answers; the recommendation (Budget/Preliminary)
      // already keeps the fixture indicative, so essentialUnresolved is moot.
      essentialUnresolved: 0,
    })
    return NextResponse.json({ ok: true, clarification_status, is_indicative })
  }

  const jobId = body.job_id
  if (!jobId) return NextResponse.json({ error: 'job_id required' }, { status: 400 })

  try {
    const supabase = await admin()

    if (action === 'answer') {
      if (!body.question_id) return NextResponse.json({ error: 'question_id required' }, { status: 400 })
      const answer = (body.answer ?? '').trim()
      await supabase
        .from('open_questions')
        .update({ resolved: answer.length > 0, answer: answer || null })
        .eq('id', body.question_id)
        .eq('builder_id', builderId)
        .eq('job_id', jobId)
      return NextResponse.json({ ok: true })
    }

    // skip | complete both resolve the clarification state and recompute is_indicative
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { data: scopeRow }: any = await supabase
      .from('project_scope')
      .select('recommended_estimate_type')
      .eq('builder_id', builderId)
      .eq('job_id', jobId)
      .maybeSingle()
    const recommended = (scopeRow?.recommended_estimate_type as EstimateType) ?? 'Budget/Preliminary'

    let essentialUnresolved = 0
    if (action === 'complete') {
      const { data: qRows } = await supabase
        .from('open_questions')
        .select('question_group, resolved')
        .eq('builder_id', builderId)
        .eq('job_id', jobId)
      essentialUnresolved = (qRows ?? []).filter(
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (q: any) => ESSENTIAL_QUESTION_GROUPS.includes(q.question_group) && !q.resolved
      ).length
    }

    const clarification_status: ClarificationStatus = action === 'skip' ? 'skipped' : 'answered'
    const is_indicative = computeIsIndicative({
      clarificationStatus: clarification_status,
      recommendedEstimateType: recommended,
      essentialUnresolved,
    })

    await supabase
      .from('project_scope')
      .update({ clarification_status, is_indicative, updated_at: new Date().toISOString() })
      .eq('builder_id', builderId)
      .eq('job_id', jobId)

    return NextResponse.json({ ok: true, clarification_status, is_indicative })
  } catch (err) {
    console.error('[questions:post]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not update questions.' }, { status: 500 })
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function admin(): Promise<any> {
  const { createClient } = await import('@supabase/supabase-js')
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
}
