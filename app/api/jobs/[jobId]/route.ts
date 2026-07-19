import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// ─── DELETE /api/jobs/[jobId] ────────────────────────────────────────────────
// Soft delete, not a real DELETE FROM — mirrors PATCH/DELETE
// /api/workers/[id]'s own deactivate pattern. jobs.status already has
// 'archived' as its final forward-only state (quoting -> quoted -> active ->
// complete -> archived, see CLAUDE.md's "Non-Negotiable Safety Rules"), and
// the read side already excludes it (GET /api/jobs, lib/worker-portal-data.ts)
// — this route was the missing write path. A real DELETE would cascade into
// quotes/variations/proof_events/project_facts, destroying exactly the
// audit trail WorkA Proof exists to guarantee; archiving just hides the job
// from lists while keeping every record intact and recoverable in the DB.
// Allowed from any status, not only 'complete' — this is a builder saying
// "stop showing me this job," not a construction-lifecycle completion event,
// so skipping ahead to the terminal state is the intended behaviour, not a
// forward-only violation (forward-only forbids going BACKWARD, not skipping
// ahead to the chain's own end state).
export async function DELETE(
  _request: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const sbUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const sbKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  if (!sbUrl || sbUrl === 'your-supabase-url' || !sbKey) {
    // Demo mode has no persistent job store to archive against.
    return NextResponse.json({ error: 'Archiving is only available in live (Supabase-connected) mode.' }, { status: 400 })
  }

  try {
    const sb = createClient(sbUrl, sbKey, { auth: { autoRefreshToken: false, persistSession: false } })
    const { data, error } = await sb
      .from('jobs')
      .update({ status: 'archived' })
      .eq('id', params.jobId)
      .eq('builder_id', builderId)
      .select('id')
      .single()

    if (error || !data) {
      console.error('[/api/jobs/[jobId]] archive failed:', error?.message)
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    console.error('[/api/jobs/[jobId]] error:', err)
    return NextResponse.json({ error: 'Failed to archive job' }, { status: 500 })
  }
}
