import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── GET /api/jobs/[jobId]/estimate-status ───────────────────────────────────
//
// The one read the builder-facing UI needs to answer "how much of what I
// uploaded did WorkA actually use, and is this estimate ready to send?" —
// backed entirely by estimate_runs (migrations 056-079), never computed
// inline here. Read-only: this route derives/generates nothing, it only
// surfaces the latest reconciled row for the job.
//
// Used by two call sites: QuoteView.tsx (banner above the quote) and
// IntakeProgress.tsx (replaces the generic "Processing timed out"/"Processing
// failed" message with a coverage-aware one once a builder_status has been
// finalized for the job's most recent batch).

interface CoverageDocument {
  file_id: string
  filename: string
  document_type?: string | null
  status?: 'failed' | 'pending'
}

export interface EstimateStatusResponse {
  has_run: boolean
  builder_status: 'ESTIMATE_READY' | 'ESTIMATE_READY_WITH_WARNINGS' | 'NEEDS_REVIEW' | null
  needs_review_reason: string | null
  needs_review_reason_code: string | null
  quote_id: string | null
  started_at: string | null
  deadline_at: string | null
  completed_at: string | null
  coverage: {
    documents_uploaded: number
    documents_analyzed: number
    documents_failed_or_pending: number
    coverage_percentage: number
    confidence_level: 'high' | 'medium' | 'low'
    contributing_documents: CoverageDocument[]
    missing_documents: CoverageDocument[]
  } | null
}

const NO_RUN_RESPONSE: EstimateStatusResponse = {
  has_run: false,
  builder_status: null,
  needs_review_reason: null,
  needs_review_reason_code: null,
  quote_id: null,
  started_at: null,
  deadline_at: null,
  completed_at: null,
  coverage: null,
}

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const { jobId } = params

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  // Demo mode has no estimate_runs/document pipeline behind it — there is
  // nothing dishonest to report here (no partial-coverage demo data
  // exists), so report "no run" rather than fabricating a confident-looking
  // coverage number for data that was never actually processed.
  if (!sbUrl || sbUrl === 'your-supabase-url' || !sbKey) {
    return NextResponse.json(NO_RUN_RESPONSE)
  }

  try {
    const sb = createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } })

    const { data: job } = await sb
      .from('jobs')
      .select('id')
      .eq('id', jobId)
      .eq('builder_id', builderId)
      .single()

    if (!job) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const { data: run, error } = await sb
      .from('estimate_runs')
      // A single string LITERAL, not built via `+` concatenation — supabase-js's
      // .select() overloads pattern-match on a literal string type to infer the
      // real row shape; concatenation widens it to plain `string`, which falls
      // back to GenericStringError and breaks every `run.<column>` access below
      // (confirmed: this is what broke every Railway build since this route was
      // added — same root cause already fixed once in this codebase, see
      // getUnresolvedConservativeAssumptions in lib/estimating/readiness.ts).
      .select(
        'builder_status, needs_review_reason, needs_review_reason_code, quote_id, started_at, deadline_at, completed_at, coverage_documents_uploaded, coverage_documents_analyzed, coverage_percentage, confidence_level, contributing_documents, missing_documents'
      )
      .eq('job_id', jobId)
      .order('started_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    if (error || !run) {
      return NextResponse.json(NO_RUN_RESPONSE)
    }

    const response: EstimateStatusResponse = {
      has_run: true,
      builder_status: (run.builder_status as EstimateStatusResponse['builder_status']) ?? null,
      needs_review_reason: run.needs_review_reason ?? null,
      needs_review_reason_code: run.needs_review_reason_code ?? null,
      quote_id: run.quote_id ?? null,
      started_at: run.started_at ?? null,
      deadline_at: run.deadline_at ?? null,
      completed_at: run.completed_at ?? null,
      coverage: run.coverage_documents_uploaded === null ? null : {
        documents_uploaded: run.coverage_documents_uploaded ?? 0,
        documents_analyzed: run.coverage_documents_analyzed ?? 0,
        documents_failed_or_pending: (run.coverage_documents_uploaded ?? 0) - (run.coverage_documents_analyzed ?? 0),
        coverage_percentage: run.coverage_percentage ?? 0,
        confidence_level: (run.confidence_level as 'high' | 'medium' | 'low') ?? 'low',
        contributing_documents: (run.contributing_documents as CoverageDocument[] | null) ?? [],
        missing_documents: (run.missing_documents as CoverageDocument[] | null) ?? [],
      },
    }

    return NextResponse.json(response)
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error('[jobs:estimate-status] unhandled error:', msg, { jobId })
    return NextResponse.json({ error: 'Failed to load estimate status.' }, { status: 500 })
  }
}
