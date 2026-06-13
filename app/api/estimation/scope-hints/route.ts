import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─── Auth ─────────────────────────────────────────────────────────────────────
// API routes are NOT protected by middleware.ts (which only covers /chat and
// /settings). This route authenticates via Authorization: Bearer <supabase-jwt>
// so it works for both browser clients (which receive a JWT from Supabase Auth)
// and internal callers (which use the service-role key).

async function getAuthenticatedBuilderId(req: NextRequest): Promise<
  { builder_id: string; error?: never } | { builder_id?: never; error: string; status: number }
> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  // Demo mode
  if (!supabaseUrl || !serviceRoleKey) {
    return { builder_id: '00000000-0000-0000-0000-000000000001' }
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return { error: 'Missing Authorization: Bearer <token> header', status: 401 }
  }

  // Internal service-role callers
  if (token === serviceRoleKey) {
    const builder_id = req.nextUrl.searchParams.get('builder_id') ?? ''
    if (!builder_id) return { error: 'builder_id query param required for service-role calls', status: 400 }
    return { builder_id }
  }

  // Validate Supabase JWT
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) {
    return { error: 'Invalid or expired token', status: 401 }
  }

  return { builder_id: user.id }
}

// ─── POST /api/estimation/scope-hints ─────────────────────────────────────────
// Returns AI-generated scope hints for a trade category based on job context.
// Used by the quote UI to suggest line items the builder may have missed.
//
// Request body:
//   { trade_category_id: number, job_id?: string, context?: string }
//
// Response:
//   { hints: Array<{ description: string, unit: string, confidence: number }> }

export async function POST(req: NextRequest): Promise<NextResponse> {
  const t0 = Date.now()
  console.log('[scope-hints] START')

  // ── Auth ──────────────────────────────────────────────────────────────────
  const auth = await getAuthenticatedBuilderId(req)
  if (auth.error) {
    console.warn(`[scope-hints] AUTH FAILED: ${auth.error} elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: auth.error }, { status: auth.status })
  }
  const { builder_id } = auth
  console.log(`[scope-hints] AUTH OK builder_id=${builder_id} elapsed=${Date.now() - t0}ms`)

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { trade_category_id?: number; job_id?: string; context?: string } = {}
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const { trade_category_id, job_id, context } = body
  if (!trade_category_id || trade_category_id < 1 || trade_category_id > 13) {
    return NextResponse.json(
      { error: 'trade_category_id must be an integer 1–13' },
      { status: 400 }
    )
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const isDemoMode = !process.env.NEXT_PUBLIC_SUPABASE_URL || !anthropicKey

  // ── Demo mode ─────────────────────────────────────────────────────────────
  if (isDemoMode) {
    console.log(`[scope-hints] demo mode elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({
      hints: DEMO_HINTS[trade_category_id] ?? [],
      trade_category_id,
    })
  }

  // ── Job context (optional) ─────────────────────────────────────────────────
  let jobContext = context ?? ''

  if (job_id) {
    const tCtx0 = Date.now()
    console.log(`[scope-hints] STEP: fetch job context job_id=${job_id}`)
    const supabase = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
    const { data: job } = await supabase
      .from('jobs')
      .select('address, client_name, status')
      .eq('id', job_id)
      .eq('builder_id', builder_id)
      .single()

    if (job) {
      jobContext = `Job: ${job.address}, Client: ${job.client_name ?? 'unknown'}, Status: ${job.status}. ${jobContext}`
    }
    console.log(`[scope-hints] STEP COMPLETE fetch job context elapsed=${Date.now() - tCtx0}ms`)
  }

  // ── Anthropic call ────────────────────────────────────────────────────────
  const tAi0 = Date.now()
  console.log(`[scope-hints] STEP: anthropic scope hints trade_category_id=${trade_category_id}`)

  const TRADE_NAMES: Record<number, string> = {
    1: 'Site Works & Concrete', 2: 'Framing', 3: 'Roofing', 4: 'External Cladding',
    5: 'Insulation', 6: 'Internal Linings', 7: 'Fit-out Carpentry', 8: 'Cabinetry',
    9: 'Paint', 10: 'Flooring', 11: 'Fixtures & Tapware', 12: 'Electrical', 13: 'Preliminaries',
  }

  const tradeName = TRADE_NAMES[trade_category_id]

  let hints: Array<{ description: string; unit: string; confidence: number }> = []

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey: anthropicKey })

    const response = await client.messages.create(
      {
        model: 'claude-sonnet-4-20250514',
        max_tokens: 1024,
        messages: [
          {
            role: 'user',
            content: `You are a quantity surveyor for Australian residential construction.

Suggest up to 8 common line items for the trade category "${tradeName}" that a builder might include in a residential construction quote.
${jobContext ? `\nJob context: ${jobContext}` : ''}

Return a JSON object:
{
  "hints": [
    { "description": string, "unit": "m2"|"lm"|"each"|"m3"|"hr", "confidence": 60-90 }
  ]
}

Return ONLY valid JSON. No explanation, no markdown.`,
          },
        ],
      },
      { timeout: 30_000 }
    )

    const text = response.content[0]?.type === 'text' ? response.content[0].text : ''
    const parsed = JSON.parse(text) as { hints?: typeof hints }
    hints = parsed.hints ?? []
  } catch (err) {
    console.error(`[scope-hints] Anthropic failed elapsed=${Date.now() - tAi0}ms`, err)
    // Fall back to static hints rather than failing the request
    hints = DEMO_HINTS[trade_category_id] ?? []
  }

  console.log(`[scope-hints] STEP COMPLETE anthropic elapsed=${Date.now() - tAi0}ms hints=${hints.length}`)
  console.log(`[scope-hints] END elapsed=${Date.now() - t0}ms`)

  return NextResponse.json({ hints, trade_category_id })
}

// ─── Static fallback hints (also used in demo mode) ───────────────────────────

const DEMO_HINTS: Record<number, Array<{ description: string; unit: string; confidence: number }>> = {
  1: [
    { description: 'Site cut and fill', unit: 'm3', confidence: 70 },
    { description: 'Strip footings', unit: 'lm', confidence: 75 },
    { description: 'Concrete slab on ground', unit: 'm2', confidence: 80 },
    { description: 'Drainage connections', unit: 'each', confidence: 65 },
  ],
  2: [
    { description: 'Structural wall framing', unit: 'm2', confidence: 80 },
    { description: 'Roof trusses supply & install', unit: 'each', confidence: 75 },
    { description: 'LVL beams', unit: 'lm', confidence: 70 },
    { description: 'Structural steel posts', unit: 'each', confidence: 65 },
  ],
  3: [
    { description: 'Colorbond roofing', unit: 'm2', confidence: 80 },
    { description: 'Gutters & downpipes', unit: 'lm', confidence: 75 },
    { description: 'Roof flashings', unit: 'lm', confidence: 70 },
  ],
  4: [
    { description: 'Brick veneer external walls', unit: 'm2', confidence: 80 },
    { description: 'Rendered finish', unit: 'm2', confidence: 75 },
  ],
  5: [
    { description: 'Wall insulation batts', unit: 'm2', confidence: 80 },
    { description: 'Ceiling insulation R4.0', unit: 'm2', confidence: 80 },
    { description: 'Under-slab insulation', unit: 'm2', confidence: 70 },
  ],
  6: [
    { description: 'Plasterboard walls 10mm', unit: 'm2', confidence: 80 },
    { description: 'Plasterboard ceiling 10mm', unit: 'm2', confidence: 80 },
    { description: 'Wet area lining', unit: 'm2', confidence: 75 },
  ],
  7: [
    { description: 'Architraves & skirting', unit: 'lm', confidence: 75 },
    { description: 'Internal doors supply & hang', unit: 'each', confidence: 80 },
    { description: 'Staircase', unit: 'each', confidence: 70 },
  ],
  8: [
    { description: 'Kitchen cabinetry', unit: 'each', confidence: 70 },
    { description: 'Bathroom vanities', unit: 'each', confidence: 75 },
    { description: 'Laundry cabinetry', unit: 'each', confidence: 75 },
  ],
  9: [
    { description: 'Interior walls 2 coat', unit: 'm2', confidence: 80 },
    { description: 'Ceilings 2 coat', unit: 'm2', confidence: 80 },
    { description: 'Exterior paint', unit: 'm2', confidence: 75 },
  ],
  10: [
    { description: 'Timber flooring', unit: 'm2', confidence: 80 },
    { description: 'Ceramic tiles', unit: 'm2', confidence: 80 },
    { description: 'Carpet', unit: 'm2', confidence: 80 },
  ],
  11: [
    { description: 'Bathroom fixtures package', unit: 'each', confidence: 70 },
    { description: 'Kitchen tapware', unit: 'each', confidence: 75 },
    { description: 'Toilet suite', unit: 'each', confidence: 80 },
  ],
  12: [
    { description: 'Rough-in electrical', unit: 'each', confidence: 70 },
    { description: 'Switchboard & final fix', unit: 'each', confidence: 70 },
    { description: 'Smoke alarms', unit: 'each', confidence: 80 },
  ],
  13: [
    { description: 'Project management', unit: 'each', confidence: 75 },
    { description: 'Site establishment & fencing', unit: 'each', confidence: 80 },
    { description: 'Council building permit', unit: 'each', confidence: 85 },
    { description: 'Temporary services', unit: 'each', confidence: 70 },
  ],
}
