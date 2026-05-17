import { NextRequest, NextResponse } from 'next/server'
import { getDemoJobSnapshot } from '@/lib/job-snapshot-demo'

// ─── GET /api/jobs/[jobId]/snapshot ──────────────────────────────────────────

export async function GET(
  _req: NextRequest,
  { params }: { params: { jobId: string } }
): Promise<NextResponse> {
  const { jobId } = params

  // ── Demo mode ─────────────────────────────────────────────────────────────
  const isDemoMode =
    !process.env.NEXT_PUBLIC_SUPABASE_URL ||
    process.env.NEXT_PUBLIC_SUPABASE_URL === 'your-supabase-url'

  if (isDemoMode) {
    const snapshot = getDemoJobSnapshot(jobId)

    if (!snapshot) {
      return NextResponse.json(
        { error: 'Job not found' },
        { status: 404 }
      )
    }

    return NextResponse.json({ snapshot })
  }

  // ── Real mode (Supabase configured) ───────────────────────────────────────
  // When Supabase is available, query all relevant tables and assemble the
  // snapshot. This path is reached in production once NEXT_PUBLIC_SUPABASE_URL
  // is set to a real project URL.
  //
  // For now, fall back to demo data so the UI always has something to render.
  const snapshot = getDemoJobSnapshot(jobId)
  if (!snapshot) {
    return NextResponse.json({ error: 'Job not found' }, { status: 404 })
  }
  return NextResponse.json({ snapshot })
}
