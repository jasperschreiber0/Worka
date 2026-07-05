import { NextRequest, NextResponse } from 'next/server'
import { isDemoMode, getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { DEMO_ASSESSMENT } from '@/lib/estimation-assessment-demo'
import {
  classifyDocuments,
  reasonAboutScope,
  type ProjectAssessment,
  type ClassifiedDocument,
  type ScopeReasoning,
  type OpenQuestion,
  type StatedPurpose,
} from '@/lib/estimation-reasoning'

// Node runtime — uses Buffer + supabase-js; two Claude calls need headroom.
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ─── POST /api/estimation/assess ──────────────────────────────────────────────
// Runs the reason-first stage for a document bundle: per-document classification
// (with letterhead/unreadable detection) + scope reasoning + open questions.
// Demo mode returns the 16 Alfred St fixture. No pricing happens here.

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { job_id?: string; file_ids?: string[]; stated_purpose?: StatedPurpose }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const jobId = body.job_id ?? null

  // ── Demo mode ──────────────────────────────────────────────────────────────
  if (isDemoMode()) {
    return NextResponse.json({ assessment: { ...DEMO_ASSESSMENT, job_id: jobId }, demo: true })
  }

  // ── Real mode ──────────────────────────────────────────────────────────────
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!supabaseUrl || !supabaseKey) return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  if (!anthropicKey) return NextResponse.json({ error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })

  const fileIds = Array.isArray(body.file_ids) ? body.file_ids.slice(0, 8) : []
  if (fileIds.length === 0) return NextResponse.json({ error: 'No file_ids supplied' }, { status: 400 })

  try {
    const { createClient } = await import('@supabase/supabase-js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = createClient(supabaseUrl, supabaseKey)
    const { getCachedFile } = await import('@/lib/file-cache')
    const { extractPdfText, hasUsableText, buildTextLayerBlock } = await import('@/lib/pdf-text')

    // ── Load each file → doc block (+ text layer for PDFs) ────────────────────
    const MAX_TOTAL_BYTES = 20 * 1024 * 1024
    let attachedBytes = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const docBlocks: any[] = []
    const files: Array<{ file_id: string | null; filename: string; textLayer?: string }> = []

    for (const fileId of fileIds) {
      let base64: string | null = null
      let mediaType = 'application/pdf'
      let filename = fileId

      const cached = getCachedFile(fileId)
      if (cached) {
        base64 = cached.base64
        mediaType = cached.mediaType
        filename = cached.filename ?? fileId
      } else {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const rowRes: any = await Promise.race([
          supabase.from('files').select('*').eq('id', fileId).eq('builder_id', builderId).single(),
          new Promise((resolve) => setTimeout(() => resolve({ data: null }), 8_000)),
        ])
        const row = rowRes?.data
        if (!row) continue
        filename = row.filename ?? fileId
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const dl: any = await Promise.race([
          supabase.storage.from('plans').download(row.storage_path),
          new Promise((resolve) => setTimeout(() => resolve({ data: null }), 30_000)),
        ])
        if (!dl?.data) continue
        base64 = Buffer.from(await dl.data.arrayBuffer()).toString('base64')
        mediaType = row.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg'
      }

      if (!base64) continue
      const bytes = Math.ceil(base64.length * 0.75)
      if (attachedBytes + bytes > MAX_TOTAL_BYTES) continue
      attachedBytes += bytes

      const isPdf = mediaType.includes('pdf')
      const isCsv = mediaType.includes('csv') || mediaType.includes('text/plain')

      let textLayer: string | undefined
      if (isCsv) {
        const csvText = Buffer.from(base64, 'base64').toString('utf-8')
        docBlocks.push({ type: 'text', text: `FILE ${filename}:\n\`\`\`\n${csvText.slice(0, 40000)}\n\`\`\`` })
        textLayer = csvText
      } else if (isPdf) {
        docBlocks.push({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } })
        const text: string = await Promise.race([
          extractPdfText(base64),
          new Promise<string>((resolve) => setTimeout(() => resolve(''), 12_000)),
        ])
        if (hasUsableText(text)) {
          docBlocks.push(buildTextLayerBlock(text))
          textLayer = text
        }
      } else {
        docBlocks.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } })
      }

      files.push({ file_id: fileId, filename, textLayer })
    }

    if (files.length === 0) return NextResponse.json({ error: 'No readable files could be loaded' }, { status: 400 })

    // ── Pass 1: classify each document ────────────────────────────────────────
    const documents = await classifyDocuments(anthropicKey, docBlocks, files)

    // ── Pass 2: reason about scope ────────────────────────────────────────────
    const { scope, openQuestions } = await reasonAboutScope(
      anthropicKey,
      docBlocks,
      documents,
      body.stated_purpose ?? null
    )

    const assessment: ProjectAssessment = {
      job_id: jobId,
      documents,
      scope,
      open_questions: openQuestions,
      generated_at: new Date().toISOString(),
      demo: false,
    }

    // ── Persist (best-effort — a store failure never blocks returning the work)
    if (jobId) {
      await persistAssessment(supabase, builderId, jobId, documents, scope, openQuestions).catch((e) =>
        console.error('[assess:persist]', e instanceof Error ? e.message : String(e))
      )
    }

    return NextResponse.json({ assessment, demo: false })
  } catch (err) {
    console.error('[assess:error]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not assess the documents. Please try again.' }, { status: 500 })
  }
}

// ─── GET /api/estimation/assess?job_id= ───────────────────────────────────────
// Fetch the stored assessment for a job (demo returns the fixture).

export async function GET(req: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const jobId = new URL(req.url).searchParams.get('job_id')

  if (isDemoMode()) {
    return NextResponse.json({ assessment: { ...DEMO_ASSESSMENT, job_id: jobId }, demo: true })
  }

  if (!jobId) return NextResponse.json({ error: 'job_id required' }, { status: 400 })

  try {
    const { createClient } = await import('@supabase/supabase-js')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const supabase: any = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)

    const [{ data: scopeRow }, { data: docRows }, { data: qRows }] = await Promise.all([
      supabase.from('project_scope').select('*').eq('builder_id', builderId).eq('job_id', jobId).maybeSingle(),
      supabase.from('documents').select('*').eq('builder_id', builderId).eq('job_id', jobId).order('created_at'),
      supabase.from('open_questions').select('*').eq('builder_id', builderId).eq('job_id', jobId).order('created_at'),
    ])

    if (!scopeRow) return NextResponse.json({ assessment: null, demo: false })

    const assessment = rebuildAssessment(jobId, scopeRow, docRows ?? [], qRows ?? [])
    return NextResponse.json({ assessment, demo: false })
  } catch (err) {
    console.error('[assess:get]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not load the assessment.' }, { status: 500 })
  }
}

// ─── Persistence helpers ──────────────────────────────────────────────────────

async function persistAssessment(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  builderId: string,
  jobId: string,
  documents: ClassifiedDocument[],
  scope: ScopeReasoning,
  openQuestions: OpenQuestion[]
): Promise<void> {
  // Replace-in-place: this is a fresh assessment of the same bundle.
  await supabase.from('documents').delete().eq('builder_id', builderId).eq('job_id', jobId)
  await supabase.from('open_questions').delete().eq('builder_id', builderId).eq('job_id', jobId)

  if (documents.length > 0) {
    await supabase.from('documents').insert(
      documents.map((d) => ({
        builder_id: builderId,
        job_id: jobId,
        file_id: d.file_id,
        filename: d.filename,
        category: d.category,
        category_confidence: d.category_confidence,
        issue_status: d.issue_status,
        document_date: d.document_date,
        author: d.author,
        extraction_status: d.extraction_status,
        content_summary: d.content_summary,
        unreadable_reason: d.unreadable_reason,
      }))
    )
  }

  await supabase.from('project_scope').upsert(
    {
      builder_id: builderId,
      job_id: jobId,
      project_type: scope.project_type,
      scope_summary: scope.scope_summary,
      site_data: scope.site_data,
      room_scope: scope.room_scope,
      specialty_inclusions: scope.specialty_inclusions,
      date_mismatches: scope.date_mismatches,
      complexity_rating: scope.complexity_rating,
      complexity_justification: scope.complexity_justification,
      recommended_estimate_type: scope.recommended_estimate_type,
      estimate_type_justification: scope.estimate_type_justification,
      trade_list: scope.trade_list,
      assumptions: scope.assumptions,
      risks: scope.risks,
      exclusions: scope.exclusions,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'job_id' }
  )

  if (openQuestions.length > 0) {
    await supabase.from('open_questions').insert(
      openQuestions.map((q) => ({
        builder_id: builderId,
        job_id: jobId,
        question_group: q.group,
        question_text: q.question,
        source_reference: q.source_reference,
      }))
    )
  }
}

function rebuildAssessment(
  jobId: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  scopeRow: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  docRows: any[],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  qRows: any[]
): ProjectAssessment {
  return {
    job_id: jobId,
    demo: false,
    generated_at: scopeRow.updated_at ?? scopeRow.created_at ?? new Date().toISOString(),
    documents: docRows.map((d) => ({
      file_id: d.file_id ?? null,
      filename: d.filename,
      category: d.category,
      category_confidence: d.category_confidence ?? 50,
      issue_status: d.issue_status ?? 'unknown',
      document_date: d.document_date ?? null,
      author: d.author ?? null,
      extraction_status: d.extraction_status ?? 'partial',
      content_summary: d.content_summary ?? '',
      unreadable_reason: d.unreadable_reason ?? null,
    })),
    scope: {
      project_type: scopeRow.project_type ?? '',
      scope_summary: scopeRow.scope_summary ?? [],
      site_data: scopeRow.site_data ?? {},
      room_scope: scopeRow.room_scope ?? [],
      specialty_inclusions: scopeRow.specialty_inclusions ?? [],
      date_mismatches: scopeRow.date_mismatches ?? [],
      complexity_rating: scopeRow.complexity_rating ?? 'Medium',
      complexity_justification: scopeRow.complexity_justification ?? [],
      recommended_estimate_type: scopeRow.recommended_estimate_type ?? 'Budget/Preliminary',
      estimate_type_justification: scopeRow.estimate_type_justification ?? '',
      trade_list: scopeRow.trade_list ?? [],
      assumptions: scopeRow.assumptions ?? [],
      risks: scopeRow.risks ?? [],
      exclusions: scopeRow.exclusions ?? [],
    },
    open_questions: qRows.map((q) => ({
      group: q.question_group,
      question: q.question_text,
      source_reference: q.source_reference ?? null,
    })),
  }
}
