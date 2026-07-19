import { NextRequest, NextResponse } from 'next/server'
import { getAuthenticatedBuilderId, isDemoMode as isDemo } from '@/lib/auth/api-auth'
import { DEMO_PROJECT_MEMORY } from '@/lib/estimation-demo'
import { withTimeoutAndRetry } from '@/supabase/functions/smooth-responder/pipeline-logic'
import { guardedClaudeCall } from '@/supabase/functions/smooth-responder/ai-gateway'
import { gatewaySupabase } from '@/lib/ai-gateway-client'

// ─── Estimation history — the corpus behind the parametric estimator ──────────
//
// GET  → list the builder's completed jobs held in project_memory (the
//        comparables the estimator draws on).
// POST → "seed" a past job: extract its metadata + delivered total from a priced
//        PDF (a trade breakdown / quote) and write one project_memory row, so
//        the estimator is accurate from day one instead of after months of jobs.

interface HistoryRecord {
  id: string
  job_type: string | null
  finish_level: string | null
  region: string | null
  suburb: string | null
  floor_area_m2: number | null
  storeys: number | null
  wet_areas: number | null
  project_summary: string | null
  total_cost: number | null
  cost_per_m2: number | null
}

function withPerM2(r: Omit<HistoryRecord, 'cost_per_m2'>): HistoryRecord {
  const cost_per_m2 =
    r.total_cost && r.floor_area_m2 && r.floor_area_m2 > 0 ? Math.round(r.total_cost / r.floor_area_m2) : null
  return { ...r, cost_per_m2 }
}

// ─── GET — list history ───────────────────────────────────────────────────────

export async function GET(): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  if (isDemo()) {
    const records = DEMO_PROJECT_MEMORY.map((p) =>
      withPerM2({
        id: p.id,
        job_type: p.job_type,
        finish_level: p.finish_level,
        region: p.region,
        suburb: p.suburb,
        floor_area_m2: p.floor_area_m2,
        storeys: p.storeys,
        wet_areas: p.wet_areas,
        project_summary: p.project_summary,
        total_cost: p.final_cost ?? p.quoted_cost,
      })
    )
    return NextResponse.json({ records, demo: true })
  }

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data } = await sb
      .from('project_memory')
      .select('id, job_type, finish_level, region, suburb, floor_area_m2, storeys, wet_areas, project_summary, quoted_cost, final_cost')
      .eq('builder_id', builderId)
      .in('status', ['completed', 'active'])
      .order('completed_at', { ascending: false })
      .limit(100)

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const records = (data ?? []).map((p: any) =>
      withPerM2({
        id: p.id,
        job_type: p.job_type,
        finish_level: p.finish_level,
        region: p.region,
        suburb: p.suburb,
        floor_area_m2: p.floor_area_m2,
        storeys: p.storeys,
        wet_areas: p.wet_areas,
        project_summary: p.project_summary,
        total_cost: p.final_cost ?? p.quoted_cost,
      })
    )
    return NextResponse.json({ records, demo: false })
  } catch (err) {
    console.error('[history:get]', err)
    return NextResponse.json({ records: [], demo: false })
  }
}

// ─── POST — seed one past job from a priced PDF ───────────────────────────────

const EXTRACT_SCHEMA = {
  type: 'object' as const,
  properties: {
    job_type: { type: 'string', enum: ['rear_extension', 'side_extension', 'bathroom_reno', 'kitchen_reno', 'double_storey', 'granny_flat', 'new_build', 'knockdown_rebuild', 'full_renovation', 'deck_pergola', 'other'] },
    finish_level: { type: 'string', enum: ['budget', 'standard', 'premium', 'luxury'] },
    region: { type: ['string', 'null'], enum: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT', null] },
    suburb: { type: ['string', 'null'] },
    floor_area_m2: { type: ['number', 'null'] },
    storeys: { type: ['integer', 'null'] },
    wet_areas: { type: ['integer', 'null'] },
    project_summary: { type: 'string' },
    total_cost_ex_gst: { type: ['number', 'null'], description: 'Contract price the client pays, EXCLUDING GST — i.e. the cost subtotal plus the builder\'s margin, before GST is added. Not the GST-inclusive grand total.' },
    trade_breakdown: { type: 'object', additionalProperties: { type: 'number' }, description: 'Optional map of trade_category_id (1-13) as string keys → cost for that trade, if the document breaks costs out by trade. Omit if not clearly broken down.' },
  },
  required: ['job_type', 'finish_level', 'project_summary', 'total_cost_ex_gst'],
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let formData: FormData
  try {
    formData = await request.formData()
  } catch {
    return NextResponse.json({ error: 'Invalid form data' }, { status: 400 })
  }
  const file = formData.get('file') as File | null
  if (!file) return NextResponse.json({ error: 'No file provided' }, { status: 400 })

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    return NextResponse.json({ error: 'Extraction needs an Anthropic API key. Connect one to seed real jobs.' }, { status: 400 })
  }

  try {
    const base64Data = Buffer.from(await file.arrayBuffer()).toString('base64')

    // Text layer = authoritative for the total (avoids misread price tables).
    const { extractPdfText, hasUsableText, buildTextLayerBlock } = await import('@/lib/pdf-text')
    const textLayer = await Promise.race([
      extractPdfText(base64Data),
      new Promise<string>((resolve) => setTimeout(() => resolve(''), 15_000)),
    ])

    const { default: Anthropic } = await import('@anthropic-ai/sdk')
    const client = new Anthropic({ apiKey: anthropicKey })

    const systemPrompt = `You are cataloguing a completed Australian residential building job from its priced quote / trade breakdown, to store as a historical reference. Extract the project's high-level characteristics and its delivered contract price. The contract price EXCLUDES GST (use the subtotal + margin figure, not the GST-inclusive grand total). Floor area is the built/renovated area in m². If the document is not a priced residential building job, still return your best assessment.`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { response } = await guardedClaudeCall<any>(
      { supabase: gatewaySupabase(), attribution: { kind: 'builder', builderId }, callSite: 'estimation_history_catalogue', model: 'claude-sonnet-4-6' },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (signal) => (client.messages.create as any)({
        model: 'claude-sonnet-4-6',
        max_tokens: 1024,
        system: systemPrompt,
        tools: [{ name: 'catalogue_job', description: 'Return the project characteristics and delivered price', input_schema: EXTRACT_SCHEMA }],
        tool_choice: { type: 'tool', name: 'catalogue_job' },
        messages: [
          {
            role: 'user',
            content: [
              { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
              ...(hasUsableText(textLayer) ? [buildTextLayerBlock(textLayer)] : []),
              { type: 'text', text: 'Catalogue this completed job. Use the catalogue_job tool.' },
            ],
          },
        ],
      }, { signal }),
      { timeoutMs: 60_000, maxRetries: 1, label: 'estimation_history_catalogue' }
    )

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const block = response.content?.find((b: any) => b.type === 'tool_use' && b.name === 'catalogue_job')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const x = (block?.input ?? {}) as any
    if (!block || typeof x.total_cost_ex_gst !== 'number' || x.total_cost_ex_gst <= 0) {
      return NextResponse.json({ error: 'Could not read a project total from this document. Make sure it is a priced quote or trade breakdown.' }, { status: 422 })
    }

    const record = withPerM2({
      id: 'pending',
      job_type: x.job_type ?? null,
      finish_level: x.finish_level ?? null,
      region: x.region ?? null,
      suburb: x.suburb ?? null,
      floor_area_m2: typeof x.floor_area_m2 === 'number' ? x.floor_area_m2 : null,
      storeys: typeof x.storeys === 'number' ? x.storeys : null,
      wet_areas: typeof x.wet_areas === 'number' ? x.wet_areas : null,
      project_summary: x.project_summary ?? null,
      total_cost: x.total_cost_ex_gst,
    })

    // Demo mode: extraction works, but there's no store to persist to.
    if (isDemo()) {
      return NextResponse.json({ record: { ...record, id: `demo-${Date.now()}` }, saved: false, demo: true })
    }

    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { data: inserted, error } = await sb
      .from('project_memory')
      .insert({
        builder_id: builderId,
        status: 'completed',
        job_type: record.job_type,
        finish_level: record.finish_level,
        region: record.region,
        suburb: record.suburb,
        floor_area_m2: record.floor_area_m2,
        storeys: record.storeys,
        wet_areas: record.wet_areas,
        project_summary: record.project_summary,
        quoted_cost: record.total_cost,
        trade_breakdown: x.trade_breakdown && typeof x.trade_breakdown === 'object' ? x.trade_breakdown : {},
        completed_at: new Date().toISOString(),
      })
      .select('id')
      .single()

    if (error) {
      console.error('[history:post] insert', error.message)
      return NextResponse.json({ error: 'Extracted the job but could not save it. Please try again.' }, { status: 500 })
    }

    return NextResponse.json({ record: { ...record, id: inserted?.id ?? 'saved' }, saved: true, demo: false })
  } catch (err) {
    console.error('[history:post]', err instanceof Error ? err.message : String(err))
    return NextResponse.json({ error: 'Could not read this document. Please try again or re-export the PDF.' }, { status: 500 })
  }
}

// ─── PATCH — correct a stored job's floor area (or total) ─────────────────────
// Floor area is the softest input the estimator relies on — a builder confirming
// or filling it in immediately sharpens every estimate that draws on this job.

export async function PATCH(request: NextRequest): Promise<NextResponse> {
  const builderId = await getAuthenticatedBuilderId()
  if (!builderId) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: { id?: string; floor_area_m2?: number | null; total_cost?: number | null }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }
  if (!body.id) return NextResponse.json({ error: 'id required' }, { status: 400 })

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const patch: Record<string, any> = {}
  if (body.floor_area_m2 !== undefined) {
    if (body.floor_area_m2 !== null && (!(body.floor_area_m2 > 0))) {
      return NextResponse.json({ error: 'Floor area must be a positive number.' }, { status: 400 })
    }
    patch.floor_area_m2 = body.floor_area_m2
  }
  if (typeof body.total_cost === 'number' && body.total_cost > 0) patch.quoted_cost = body.total_cost
  if (Object.keys(patch).length === 0) return NextResponse.json({ error: 'Nothing to update.' }, { status: 400 })

  // Demo rows aren't persisted — the client keeps the correction for the session.
  if (isDemo()) return NextResponse.json({ ok: true, demo: true })

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const sb = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
    const { error } = await sb.from('project_memory').update(patch).eq('id', body.id).eq('builder_id', builderId)
    if (error) {
      console.error('[history:patch]', error.message)
      return NextResponse.json({ error: 'Could not save the change. Please try again.' }, { status: 500 })
    }
    return NextResponse.json({ ok: true })
  } catch (err) {
    console.error('[history:patch]', err)
    return NextResponse.json({ error: 'Could not save the change. Please try again.' }, { status: 500 })
  }
}

export const maxDuration = 60
