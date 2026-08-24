import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

// ─── POST /api/jobs/[jobId]/estimate ──────────────────────────────────────────
//
// "Create Estimate" — the manual-estimate entry point. Creates a blank draft
// quote for a job that doesn't have one yet, with no document upload and no
// AI call. Deliberately reuses the exact insert shape and dedup logic
// smooth-responder/index.ts already uses when it builds a quote from
// extraction (same defaults, same "does this job already have a draft/
// pending_review quote?" check via set_current_quote) — this is not a second
// quote-creation path, it's the same one, just triggered by a click instead
// of a completed AI run. That's also what makes AI safe to run later on a
// job that already has a manually-started estimate: the pipeline will find
// and add to this same row rather than creating a second one.

export async function POST(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  const { jobId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: jobRow } = await supabase
      .from('jobs')
      .select('id')
      .eq('id', jobId)
      .eq('builder_id', builderId)
      .single()
    if (!jobRow) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    // Reuse an existing draft/pending_review quote instead of creating a
    // second one — same rule smooth-responder applies (index.ts, Stage 6
    // "Incremental upload" comment). Makes this endpoint safe to call twice
    // (a double click, or clicking it after AI already started an estimate).
    const { data: existingQuote } = await supabase
      .from('quotes')
      .select('id')
      .eq('job_id', jobId)
      .in('status', ['draft', 'pending_review'])
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()

    let quoteId: string
    if (existingQuote) {
      quoteId = existingQuote.id
    } else {
      const { data: quoteRow, error: quoteErr } = await supabase
        .from('quotes')
        .insert({
          job_id: jobId,
          builder_id: builderId,
          status: 'draft',
          total_cost: null,
          margin_pct: null,
          confidence_score: null,
          version: 1,
        })
        .select('id')
        .single()
      if (quoteErr || !quoteRow) {
        return NextResponse.json({ error: 'Could not create estimate' }, { status: 500 })
      }
      quoteId = quoteRow.id
    }

    // Best-effort, matching the existing convention (revise route, smooth-
    // responder) — never lets estimate creation fail because this bookkeeping
    // call did.
    const { error: currentErr } = await supabase.rpc('set_current_quote', {
      p_job_id: jobId,
      p_quote_id: quoteId,
    })
    if (currentErr) console.error('[jobs/estimate] set_current_quote failed:', currentErr.message)

    return NextResponse.json({ quote_id: quoteId })
  } catch (err) {
    console.error('[jobs/estimate] error:', err)
    return NextResponse.json({ error: 'Failed to create estimate. Please try again.' }, { status: 500 })
  }
}
