import { NextRequest, NextResponse } from 'next/server'
import { isDemoMode, getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { buildAssessmentRunner } from '@/lib/assessment/runner'
import { createRepositories } from '@/lib/repositories'
import type { PricingMode } from '@/lib/estimate-generation'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ─── POST /api/estimation/estimate ────────────────────────────────────────────
// Thin orchestration adapter: build { kind:'generate_estimate' } → runner.run().
// Generation, guards, rate-library matching and persistence all live behind the
// runner (lib/assessment/stages.ts → lib/services.ts → lib/repositories.ts).

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: { job_id?: string; pricing_mode?: PricingMode }
  try {
    body = await req.json()
  } catch {
    body = {}
  }

  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mode: 'demo' | 'real' = isDemoMode() ? 'demo' : 'real'
  const jobId = body.job_id ?? 'demo-job'
  const pricingMode: PricingMode = body.pricing_mode === 'user_supplied' ? 'user_supplied' : 'market'

  try {
    const runner = buildAssessmentRunner(mode)
    const result = await runner.run({ kind: 'generate_estimate', jobId, pricingMode }, { builderId, mode })
    if (result.stage !== 'estimate') return NextResponse.json({ error: 'Unexpected stage' }, { status: 500 })
    return NextResponse.json({ estimate: result.data.estimate, demo: mode === 'demo' })
  } catch (err) {
    console.error('[estimate:error]', err instanceof Error ? err.message : String(err))
    const message = err instanceof Error ? err.message : 'Could not generate the estimate. Please try again.'
    return NextResponse.json({ error: message }, { status: 500 })
  }
}

// ─── GET /api/estimation/estimate?job_id= ─────────────────────────────────────
// Read-only — the latest persisted estimate for the job.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const mode: 'demo' | 'real' = isDemoMode() ? 'demo' : 'real'
  const jobId = new URL(req.url).searchParams.get('job_id') ?? 'demo-job'

  try {
    const repos = createRepositories(mode)
    const estimate = await repos.quotes.latestForJob(builderId, jobId)
    return NextResponse.json({ estimate, demo: mode === 'demo' })
  } catch (err) {
    console.error('[estimate:get]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not load the estimate.' }, { status: 500 })
  }
}
