import { NextRequest, NextResponse } from 'next/server'
import { isDemoMode, getAuthenticatedBuilderId } from '@/lib/auth/api-auth'
import { buildAssessmentRunner } from '@/lib/assessment/runner'
import type { PricingMode } from '@/lib/estimate-generation'

export const dynamic = 'force-dynamic'
export const maxDuration = 120

// ─── GET /api/estimation/estimate/export?job_id=&format=xlsx|pdf|client ───────
// Thin orchestration adapter: build { kind:'export' } → runner.render(). Workbook
// assembly and HTML rendering live in lib/services.ts (ExportService) over
// lib/estimate-export.ts / lib/xlsx.ts.

export async function GET(req: NextRequest): Promise<NextResponse | Response> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const url = new URL(req.url)
  const format = (url.searchParams.get('format') ?? 'xlsx').toLowerCase()
  if (format !== 'xlsx' && format !== 'pdf' && format !== 'client') {
    return NextResponse.json({ error: 'Unknown format' }, { status: 400 })
  }

  const mode: 'demo' | 'real' = isDemoMode() ? 'demo' : 'real'
  const jobId = url.searchParams.get('job_id') ?? 'demo-job'
  const pricingMode: PricingMode = url.searchParams.get('pricing_mode') === 'user_supplied' ? 'user_supplied' : 'market'

  try {
    const runner = buildAssessmentRunner(mode)
    const rendered = await runner.render({ kind: 'export', jobId, format, pricingMode }, { builderId, mode })

    const headers: Record<string, string> = { 'Content-Type': rendered.contentType }
    if (rendered.filename) headers['Content-Disposition'] = `attachment; filename="${rendered.filename}"`

    const body = typeof rendered.body === 'string' ? rendered.body : new Uint8Array(rendered.body)
    return new Response(body, { headers })
  } catch (err) {
    console.error('[estimate:export]', err instanceof Error ? err.message : String(err))
    const message = err instanceof Error ? err.message : 'Could not generate the export.'
    return NextResponse.json({ error: message }, { status: 404 })
  }
}
