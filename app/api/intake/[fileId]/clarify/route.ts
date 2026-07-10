import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── POST /api/intake/[fileId]/clarify ────────────────────────────────────────
// Stage 4/5 resume path. The estimating engine stopped before generating an
// estimate because a blocking gap was found (see clarifying_questions). This
// route records the builder's answers as project facts (confidence 100 — a
// direct answer from the builder outranks anything inferred from a document)
// and re-triggers the engine, which skips straight to Scope Reasoning with
// the merged fact base rather than re-classifying documents from scratch.

interface ClarifyInput {
  job_id: string
  answers: Array<{ question_id: string; answer: string }>
}

export async function POST(
  req: NextRequest,
  { params }: { params: { fileId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: ClarifyInput
  try {
    body = (await req.json()) as ClarifyInput
  } catch {
    return NextResponse.json({ error: 'Invalid request body' }, { status: 400 })
  }

  const { job_id, answers } = body
  if (!job_id || !Array.isArray(answers) || answers.length === 0) {
    return NextResponse.json({ error: 'job_id and at least one answer are required' }, { status: 400 })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isRealMode = Boolean(supabaseUrl && supabaseKey)

  if (!isRealMode) {
    return NextResponse.json({ error: 'Clarifying questions are only produced in live (Supabase-connected) mode.' }, { status: 400 })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(supabaseUrl!, supabaseKey!)

    const now = new Date().toISOString()

    for (const { question_id, answer } of answers) {
      if (!question_id || !answer) continue

      const { data: question } = await supabase
        .from('clarifying_questions')
        .update({ status: 'answered', answer, answered_at: now })
        .eq('id', question_id)
        .eq('job_id', job_id)
        .select('question')
        .single()

      if (question) {
        await supabase.from('project_facts').insert({
          job_id,
          category: 'builder_answer',
          key: question.question,
          value: answer,
          source_document_id: null,
          page_reference: null,
          evidence: 'Answered directly by the builder.',
          confidence: 100,
        })
      }
    }

    // Find the file that triggered the pause, so the client can resubscribe
    // to its SSE stream and the engine has a fileId to write progress to.
    const { data: pausedFile } = await supabase
      .from('files')
      .select('id')
      .eq('job_id', job_id)
      .eq('intake_status', 'needs_info')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    const fileId = pausedFile?.id ?? params.fileId

    const edgeFnUrl = `${supabaseUrl}/functions/v1/smooth-responder`
    const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
    const triggerRes = await fetch(edgeFnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${anonKey}` },
      body: JSON.stringify({ file_id: fileId, job_id, builder_id: builderId, resume: true }),
    })

    if (!triggerRes.ok) {
      return NextResponse.json({ error: 'Failed to resume estimating engine' }, { status: 502 })
    }

    return NextResponse.json({ ok: true, file_id: fileId })
  } catch (err) {
    console.error('Clarify route error:', err)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
