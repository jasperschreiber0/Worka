import { NextRequest, NextResponse } from 'next/server'
import {
  computeJobDocumentSimilarityPairs,
  type DocumentSignalInput,
  type DocumentSimilarityResult,
} from '@/lib/document-similarity'

// ─── GET /api/admin/document-similarity-report ───────────────────────────────
//
// Phase 2 measurement tool (see PHASE_2_DOCUMENT_MATCHING_READINESS.md):
// generates a labelled dataset of candidate near-duplicate document pairs
// across real production jobs, so Gate 3 (reliable cross-session matching
// for documents that are the SAME real-world drawing but not byte-
// identical) can be designed against evidence, not assumption.
//
// This route is READ-ONLY and has no effect on the estimating pipeline —
// it does not write to project_documents/files/project_facts, does not
// call Claude, and nothing in Stage 1-6 reads its output. `likely_category`
// in the response is a coarse triage label for a human skimming the
// export, not a classification decision — see lib/document-similarity.ts's
// own comment on computeDocumentSimilarity.
//
// Auth: there is no admin/operator role anywhere in this codebase (every
// route today is builder-session-scoped, worker-session-scoped, or
// CRON_SECRET-scoped — see CLAUDE.md's "Auth" section). This is
// deliberately platform-wide (across every builder's jobs, not one
// builder's) since a single builder's upload history isn't enough to
// answer "what do non-identical duplicates look like across real usage" —
// so it's gated the same way the existing platform-level routes
// (/api/cron/*) already are: a shared secret Bearer token, fail-closed in
// real mode exactly like CRON_SECRET. If a real admin-role system is ever
// built, this should move onto it instead of its own secret.

export const dynamic = 'force-dynamic'

const DEFAULT_MAX_JOBS = 25
const HARD_MAX_JOBS = 200

interface FileRow {
  id: string
  job_id: string
  filename: string
  content_hash: string | null
  file_size_bytes: number | null
  created_at: string
}

interface ProjectDocumentRow {
  file_id: string
  page_count: number | null
  drawing_title: string | null
}

interface DocumentProcessingJobRow {
  document_id: string
  result: { text?: string | null } | null
}

interface ReportRow extends DocumentSimilarityResult {
  job_id: string
  document_a_filename: string
  document_b_filename: string
}

function toCsv(rows: ReportRow[]): string {
  const headers = [
    'job_id', 'document_a', 'document_a_filename', 'document_b', 'document_b_filename',
    'similarity_score', 'likely_category', 'filename_similarity', 'text_overlap',
    'page_count_difference', 'same_file_size_range', 'same_detected_title', 'signals',
  ]
  const escape = (v: unknown): string => {
    const s = v === null || v === undefined ? '' : String(v)
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = [headers.join(',')]
  for (const r of rows) {
    lines.push([
      r.job_id, r.document_a, r.document_a_filename, r.document_b, r.document_b_filename,
      r.similarity_score, r.likely_category, r.filename_similarity, r.text_overlap,
      r.page_count_difference, r.same_file_size_range, r.same_detected_title, r.signals.join(';'),
    ].map(escape).join(','))
  }
  return lines.join('\n')
}

export async function GET(request: NextRequest): Promise<NextResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isRealMode = Boolean(supabaseUrl && supabaseKey)

  // ── Auth guard — fail closed, same pattern as every /api/cron/* route ──
  const adminSecret = process.env.ADMIN_REPORT_SECRET
  if (isRealMode && !adminSecret) {
    return NextResponse.json({ error: 'ADMIN_REPORT_SECRET is not configured' }, { status: 503 })
  }
  const authHeader = request.headers.get('authorization')
  if (adminSecret && authHeader !== `Bearer ${adminSecret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (!isRealMode) {
    return NextResponse.json({
      pairs: [],
      jobs_scanned: 0,
      total_pairs: 0,
      skipped: 'demo mode — no Supabase configured; this tool needs real production data to be meaningful',
    })
  }

  const url = new URL(request.url)
  const jobIdParam = url.searchParams.get('job_id')
  const format = url.searchParams.get('format') === 'csv' ? 'csv' : 'json'
  const minScore = Number(url.searchParams.get('min_score') ?? '0') || 0
  const maxJobsParam = Number(url.searchParams.get('max_jobs') ?? String(DEFAULT_MAX_JOBS))
  const maxJobs = Math.min(HARD_MAX_JOBS, Math.max(1, Number.isFinite(maxJobsParam) ? maxJobsParam : DEFAULT_MAX_JOBS))

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(supabaseUrl!, supabaseKey!)

    let jobIds: string[]

    if (jobIdParam) {
      jobIds = [jobIdParam]
    } else {
      // No RPC/GROUP BY needed — pull a bounded, recency-ordered slice of
      // files and group client-side. Bounded to keep this a lightweight
      // admin report, not a full-table scan: a job needs 2+ files to
      // produce any pair, and the most recent activity is the most
      // representative of current upload patterns.
      const { data: recentFiles, error: recentErr } = await supabase
        .from('files')
        .select('job_id, created_at')
        .order('created_at', { ascending: false })
        .limit(5000)

      if (recentErr) {
        return NextResponse.json({ error: `Failed to scan recent files: ${recentErr.message}` }, { status: 500 })
      }

      const countByJob = new Map<string, number>()
      const latestByJob = new Map<string, string>()
      for (const row of (recentFiles ?? []) as Array<{ job_id: string | null; created_at: string }>) {
        if (!row.job_id) continue
        countByJob.set(row.job_id, (countByJob.get(row.job_id) ?? 0) + 1)
        if (!latestByJob.has(row.job_id)) latestByJob.set(row.job_id, row.created_at) // first seen = most recent, since already ordered desc
      }
      jobIds = Array.from(countByJob.entries())
        .filter(([, count]) => count >= 2)
        .sort((a, b) => new Date(latestByJob.get(b[0])!).getTime() - new Date(latestByJob.get(a[0])!).getTime())
        .slice(0, maxJobs)
        .map(([jobId]) => jobId)
    }

    if (jobIds.length === 0) {
      return NextResponse.json({ pairs: [], jobs_scanned: 0, total_pairs: 0 })
    }

    const [{ data: fileRows, error: fileErr }, { data: docRows, error: docErr }] = await Promise.all([
      supabase.from('files').select('id, job_id, filename, content_hash, file_size_bytes, created_at').in('job_id', jobIds),
      supabase.from('project_documents').select('file_id, page_count, drawing_title').in('job_id', jobIds),
    ])

    if (fileErr) return NextResponse.json({ error: `Failed to load files: ${fileErr.message}` }, { status: 500 })
    if (docErr) return NextResponse.json({ error: `Failed to load project_documents: ${docErr.message}` }, { status: 500 })

    const files = (fileRows ?? []) as FileRow[]
    const fileIds = files.map((f) => f.id)

    const { data: extractionRows, error: extractionErr } = fileIds.length > 0
      ? await supabase.from('document_processing_jobs').select('document_id, result').eq('status', 'completed').in('document_id', fileIds)
      : { data: [] as DocumentProcessingJobRow[], error: null }

    if (extractionErr) return NextResponse.json({ error: `Failed to load extraction results: ${extractionErr.message}` }, { status: 500 })

    const docByFileId = new Map((docRows as ProjectDocumentRow[] ?? []).map((d) => [d.file_id, d]))
    const textByFileId = new Map(
      (extractionRows as DocumentProcessingJobRow[] ?? [])
        .filter((r) => r.result?.text)
        .map((r) => [r.document_id, r.result!.text as string])
    )

    const filesByJob = new Map<string, FileRow[]>()
    for (const f of files) {
      const list = filesByJob.get(f.job_id) ?? []
      list.push(f)
      filesByJob.set(f.job_id, list)
    }

    const filenameById = new Map(files.map((f) => [f.id, f.filename]))
    const allPairs: ReportRow[] = []

    filesByJob.forEach((jobFiles, jobId) => {
      const signalInputs: DocumentSignalInput[] = jobFiles.map((f) => ({
        fileId: f.id,
        filename: f.filename,
        contentHash: f.content_hash,
        fileSizeBytes: f.file_size_bytes,
        pageCount: docByFileId.get(f.id)?.page_count ?? null,
        drawingTitle: docByFileId.get(f.id)?.drawing_title ?? null,
        extractedText: textByFileId.get(f.id) ?? null,
      }))

      const pairs = computeJobDocumentSimilarityPairs(signalInputs)
      for (const p of pairs) {
        if (p.similarity_score < minScore) continue
        allPairs.push({
          ...p,
          job_id: jobId,
          document_a_filename: filenameById.get(p.document_a) ?? '',
          document_b_filename: filenameById.get(p.document_b) ?? '',
        })
      }
    })

    // Highest-similarity pairs first — the most useful ones for a human to
    // look at first when triaging the export.
    allPairs.sort((a, b) => b.similarity_score - a.similarity_score)

    if (format === 'csv') {
      return new NextResponse(toCsv(allPairs), {
        status: 200,
        headers: {
          'Content-Type': 'text/csv',
          'Content-Disposition': 'attachment; filename="document-similarity-report.csv"',
        },
      })
    }

    return NextResponse.json({
      jobs_scanned: filesByJob.size,
      total_pairs: allPairs.length,
      pairs: allPairs,
    })
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[admin/document-similarity-report] error:', msg)
    return NextResponse.json({ error: `Report generation failed: ${msg}` }, { status: 500 })
  }
}
