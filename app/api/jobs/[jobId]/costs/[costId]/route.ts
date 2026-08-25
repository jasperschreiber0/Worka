import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode } from '@/lib/auth/api-auth'

// ─── DELETE /api/jobs/[jobId]/costs/[costId] ──────────────────────────────────
//
// Removes one logged cost entry. Deletes only when the entry actually
// belongs to both the given job AND the authenticated builder — the two
// .eq() filters below are the real guard, not the URL params alone.

export async function DELETE(
  _req: NextRequest,
  { params }: { params: { jobId: string; costId: string } }
): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isDemoMode()) {
    return NextResponse.json({ error: 'Not available in demo mode' }, { status: 400 })
  }

  const { jobId, costId } = params

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )

    const { data: jobRow } = await supabase.from('jobs').select('id').eq('id', jobId).eq('builder_id', builderId).single()
    if (!jobRow) {
      return NextResponse.json({ error: 'Job not found' }, { status: 404 })
    }

    const { data: costRow } = await supabase
      .from('job_cost_entries')
      .select('id')
      .eq('id', costId)
      .eq('job_id', jobId)
      .eq('builder_id', builderId)
      .single()
    if (!costRow) {
      return NextResponse.json({ error: 'Cost entry not found on this job' }, { status: 404 })
    }

    const { error } = await supabase
      .from('job_cost_entries')
      .delete()
      .eq('id', costId)
      .eq('job_id', jobId)
      .eq('builder_id', builderId)

    if (error) {
      return NextResponse.json({ error: error.message }, { status: 500 })
    }

    return NextResponse.json({ deleted: true, cost_id: costId })
  } catch (err) {
    console.error('[jobs/costs:delete] error:', err)
    return NextResponse.json({ error: 'Failed to delete cost — please try again.' }, { status: 500 })
  }
}
