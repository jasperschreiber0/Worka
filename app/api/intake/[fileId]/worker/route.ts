import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'

// ─── Auth helper ──────────────────────────────────────────────────────────────
// API routes cannot rely on cookie-based session clients (browser-only).
// We accept either:
//   1. A Supabase JWT in Authorization: Bearer <token>
//   2. The service-role key (internal calls)
// Demo mode (no Supabase URL) always passes.

async function resolveCallerId(req: NextRequest): Promise<
  { builder_id: string; error?: never } | { builder_id?: never; error: string }
> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

  // Demo mode — no Supabase configured
  if (!supabaseUrl || !serviceRoleKey) {
    return { builder_id: '00000000-0000-0000-0000-000000000001' }
  }

  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null

  if (!token) {
    return { error: 'Missing Authorization header' }
  }

  // Service-role key shortcut (internal callers, e.g. cron, edge functions)
  if (token === serviceRoleKey) {
    const body = await req.json().catch(() => ({})) as { builder_id?: string }
    const builder_id = body.builder_id ?? ''
    if (!builder_id) return { error: 'builder_id required when using service role' }
    return { builder_id }
  }

  // Validate user JWT via Supabase
  const supabase = createClient(supabaseUrl, serviceRoleKey)
  const { data: { user }, error } = await supabase.auth.getUser(token)
  if (error || !user) return { error: 'Invalid or expired token' }

  return { builder_id: user.id }
}

// ─── POST /api/intake/[fileId]/worker ─────────────────────────────────────────
// Triggers the AI extraction pipeline for a file that has been uploaded.
// Returns 202 immediately — the heavy processing runs inside a Supabase Edge
// Function so it is never constrained by Vercel's 300 s serverless limit.

export async function POST(
  req: NextRequest,
  { params }: { params: { fileId: string } }
): Promise<NextResponse> {
  const t0 = Date.now()
  const { fileId } = params
  console.log(`[worker] START fileId=${fileId}`)

  // ── Auth ──────────────────────────────────────────────────────────────────
  const authResult = await resolveCallerId(req)
  if (authResult.error) {
    console.warn(`[worker] AUTH FAILED: ${authResult.error} elapsed=${Date.now() - t0}ms`)
    return NextResponse.json({ error: authResult.error }, { status: 401 })
  }
  const { builder_id } = authResult
  console.log(`[worker] AUTH OK builder_id=${builder_id} elapsed=${Date.now() - t0}ms`)

  // ── Parse body ────────────────────────────────────────────────────────────
  let body: { job_id?: string } = {}
  try {
    body = await req.json()
  } catch {
    // body is optional
  }
  const job_id = body.job_id ?? ''

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isDemoMode = !supabaseUrl || !serviceRoleKey

  // ── Demo mode — simulate async kick-off ───────────────────────────────────
  if (isDemoMode) {
    console.log(`[worker] demo mode — returning 202 elapsed=${Date.now() - t0}ms`)
    return NextResponse.json(
      { queued: true, file_id: fileId, message: 'Processing queued (demo)' },
      { status: 202 }
    )
  }

  // ── Real mode ─────────────────────────────────────────────────────────────

  const tDb0 = Date.now()
  console.log(`[worker] STEP: validate file record`)
  const supabase = createClient(supabaseUrl!, serviceRoleKey!)

  const { data: fileRow, error: fileErr } = await supabase
    .from('files')
    .select('id, intake_status, storage_path, builder_id')
    .eq('id', fileId)
    .single()
  console.log(`[worker] STEP COMPLETE validate file record elapsed=${Date.now() - tDb0}ms`)

  if (fileErr || !fileRow) {
    return NextResponse.json({ error: 'File not found' }, { status: 404 })
  }

  // Guard: only the owning builder can trigger processing
  if (fileRow.builder_id !== builder_id) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // Guard: don't re-queue an already-processing or completed file
  if (fileRow.intake_status === 'processing' || fileRow.intake_status === 'extracted') {
    return NextResponse.json(
      { queued: false, file_id: fileId, message: `File is already ${fileRow.intake_status}` },
      { status: 200 }
    )
  }

  // Mark as processing synchronously so concurrent calls are idempotent
  const tMark0 = Date.now()
  console.log(`[worker] STEP: mark file processing`)
  await supabase.from('files').update({ intake_status: 'processing' }).eq('id', fileId)
  console.log(`[worker] STEP COMPLETE mark file processing elapsed=${Date.now() - tMark0}ms`)

  // ── Dispatch to Supabase Edge Function ────────────────────────────────────
  // The edge function owns the full Anthropic call + DB writes and is NOT
  // subject to Vercel's 300 s limit. We fire-and-forget from here.
  const edgeFnUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
    ? `${process.env.NEXT_PUBLIC_SUPABASE_URL}/functions/v1/intake-worker`
    : null

  if (edgeFnUrl) {
    const tEdge0 = Date.now()
    console.log(`[worker] STEP: dispatch to edge function ${edgeFnUrl}`)
    // We do NOT await — the Vercel function returns 202 immediately
    fetch(edgeFnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${serviceRoleKey}`,
      },
      body: JSON.stringify({ file_id: fileId, job_id, builder_id }),
    }).then(() => {
      console.log(`[worker] edge function dispatched elapsed=${Date.now() - tEdge0}ms`)
    }).catch((err: unknown) => {
      console.error(`[worker] edge function dispatch failed:`, err)
    })
    console.log(`[worker] STEP COMPLETE dispatch queued elapsed=${Date.now() - t0}ms`)
  } else {
    // Fallback: if no edge function deployed yet, run inline (will risk timeout
    // on large files — move to edge function in production)
    console.warn(`[worker] WARN: intake-worker edge function not configured — running inline`)
    runInlineExtraction({ fileId, job_id, builder_id, supabaseUrl: supabaseUrl!, serviceRoleKey: serviceRoleKey! })
  }

  console.log(`[worker] END 202 elapsed=${Date.now() - t0}ms`)
  return NextResponse.json(
    { queued: true, file_id: fileId, message: 'Processing queued' },
    { status: 202 }
  )
}

// ─── Inline fallback extraction (mirrors GET route logic, with timing) ────────
// Only runs when the Supabase Edge Function is not deployed.
// Pull this out into a Supabase Edge Function as soon as possible.

async function runInlineExtraction({
  fileId,
  job_id,
  builder_id,
  supabaseUrl,
  serviceRoleKey,
}: {
  fileId: string
  job_id: string
  builder_id: string
  supabaseUrl: string
  serviceRoleKey: string
}) {
  const t0 = Date.now()
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  try {
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(supabaseUrl!, serviceRoleKey!)

    // STEP: fetch file row
    const tFetch0 = Date.now()
    console.log(`[inline] STEP: fetch file row`)
    const { data: fileRow, error: fileErr } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .single()
    console.log(`[inline] STEP COMPLETE fetch file row elapsed=${Date.now() - tFetch0}ms`)

    if (fileErr || !fileRow) throw new Error('File row not found')

    // STEP: download from storage
    const tDown0 = Date.now()
    console.log(`[inline] STEP: download file storage_path=${fileRow.storage_path}`)
    const { data: fileData, error: downloadErr } = await supabase.storage
      .from('plans')
      .download(fileRow.storage_path)
    console.log(`[inline] STEP COMPLETE download file elapsed=${Date.now() - tDown0}ms size=${fileData?.size ?? 'unknown'}`)

    if (downloadErr || !fileData) throw new Error('Storage download failed')

    // STEP: base64 encode
    const tEnc0 = Date.now()
    console.log(`[inline] STEP: base64 encode`)
    const fileBuffer = await fileData.arrayBuffer()
    const base64Data = Buffer.from(fileBuffer).toString('base64')
    const isPdf = fileRow.file_type === 'pdf'
    console.log(`[inline] STEP COMPLETE base64 encode bytes=${fileBuffer.byteLength} elapsed=${Date.now() - tEnc0}ms`)

    // STEP: Anthropic extraction
    const tAi0 = Date.now()
    console.log(`[inline] STEP: anthropic extraction`)
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey: anthropicKey })

    const messageContent = isPdf
      ? [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
          { type: 'text', text: EXTRACTION_PROMPT },
        ]
      : [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Data } },
          { type: 'text', text: EXTRACTION_PROMPT },
        ]

    let anthropicResponse = ''
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const response = await (client.messages.create as any)(
        { model: 'claude-sonnet-4-20250514', max_tokens: 4096, messages: [{ role: 'user', content: messageContent }] },
        { timeout: 220_000 }
      )
      anthropicResponse = response.content[0]?.type === 'text' ? response.content[0].text : ''
    } catch (aiErr) {
      console.error(`[inline] Anthropic call failed elapsed=${Date.now() - tAi0}ms`, aiErr)
      throw aiErr
    }
    console.log(`[inline] STEP COMPLETE anthropic extraction elapsed=${Date.now() - tAi0}ms`)

    // STEP: parse + validate
    const tParse0 = Date.now()
    console.log(`[inline] STEP: parse and validate`)
    let lineItems: Array<{
      trade_category_id: number; description: string; quantity: number | null
      unit: string | null; dimensions_string: string | null; confidence: number
    }> = []
    try {
      lineItems = (JSON.parse(anthropicResponse) as { line_items?: typeof lineItems }).line_items ?? []
    } catch { /* malformed JSON — all become assumptions */ }

    const assumptions: Array<{ description: string; gate: number; message: string }> = []
    const validatedItems = lineItems.map((item) => {
      let isAssumption = false
      let assumptionMessage: string | null = null
      let assumptionStatus: 'unresolved' | 'excluded' = 'unresolved'

      if (!item.unit) {
        isAssumption = true
        assumptionMessage = `Quantity unit not specified — please confirm the unit for ${item.description}`
        assumptions.push({ description: item.description, gate: 1, message: assumptionMessage })
      } else if (item.quantity !== null && !item.dimensions_string) {
        isAssumption = true
        assumptionMessage = `Quantity could not be verified from plans — confirm ${item.quantity} ${item.unit} for ${item.description}`
        assumptions.push({ description: item.description, gate: 2, message: assumptionMessage })
      } else if (item.quantity !== null && item.quantity <= 0) {
        isAssumption = true
        assumptionStatus = 'excluded'
        assumptionMessage = `Invalid quantity (${item.quantity}) for ${item.description} — excluded from quote`
        assumptions.push({ description: item.description, gate: 3, message: assumptionMessage })
      }
      return { ...item, is_assumption: isAssumption, assumption_status: isAssumption ? assumptionStatus : null }
    })
    console.log(`[inline] STEP COMPLETE parse and validate items=${validatedItems.length} assumptions=${assumptions.length} elapsed=${Date.now() - tParse0}ms`)

    // STEP: write quote + line items + assumptions
    const tWrite0 = Date.now()
    console.log(`[inline] STEP: write quote to database`)
    const { data: quoteRow, error: quoteErr } = await supabase
      .from('quotes')
      .insert({ job_id, builder_id, status: 'draft', total_cost: null, margin_pct: null, confidence_score: null, version: 1 })
      .select()
      .single()

    if (quoteErr || !quoteRow) throw new Error('Failed to insert quote')

    if (validatedItems.length > 0) {
      const inserts = validatedItems
        .filter((i) => i.assumption_status !== 'excluded')
        .map((i) => ({
          quote_id: quoteRow.id, trade_category_id: i.trade_category_id,
          description: i.description, quantity: i.quantity, unit: i.unit,
          rate: null, total: null, confidence: i.confidence,
          dimensions_string: i.dimensions_string, is_assumption: i.is_assumption,
          assumption_status: i.assumption_status ?? null,
        }))
      const { data: insertedItems } = await supabase.from('quote_line_items').insert(inserts).select()

      if (insertedItems && assumptions.length > 0) {
        await supabase.from('assumptions').insert(
          assumptions.map((a) => ({
            quote_id: quoteRow.id,
            line_item_id: insertedItems.find((li) => li.description === a.description)?.id ?? null,
            description: a.message, resolution_type: null, resolved_at: null, resolved_by: null,
          }))
        )
      }
    }

    await supabase.from('files').update({ intake_status: 'extracted', quote_id: quoteRow.id }).eq('id', fileId)
    console.log(`[inline] STEP COMPLETE write database elapsed=${Date.now() - tWrite0}ms`)
    console.log(`[inline] DONE total elapsed=${Date.now() - t0}ms quote_id=${quoteRow.id}`)
  } catch (err) {
    console.error(`[inline] FAILED elapsed=${Date.now() - t0}ms`, err)
    const { createClient } = await import('@supabase/supabase-js')
    const supabase = createClient(supabaseUrl, serviceRoleKey)
    await supabase.from('files').update({ intake_status: 'failed' }).eq('id', fileId)
  }
}

const EXTRACTION_PROMPT = `You are a quantity surveyor AI for Australian residential construction.

Analyse the provided building plans and extract quantities for each of the 13 trade categories below.

For each line item you identify, provide:
- trade_category_id (1–13)
- description (clear item name)
- quantity (numeric value or null if not determinable)
- unit (e.g. "m2", "lm", "each", "m3" — or null if not determinable)
- dimensions_string (e.g. "12.5m × 8.4m" — or null if not extractable from plans)
- confidence (0–100: 100 = exact from plans, 50 = estimated, 0 = not determinable)

Trade categories:
1. Site Works & Concrete
2. Framing
3. Roofing
4. External Cladding
5. Insulation
6. Internal Linings
7. Fit-out Carpentry
8. Cabinetry
9. Paint
10. Flooring
11. Fixtures & Tapware
12. Electrical
13. Preliminaries

Return a JSON object:
{
  "line_items": [
    {
      "trade_category_id": number,
      "description": string,
      "quantity": number | null,
      "unit": string | null,
      "dimensions_string": string | null,
      "confidence": number
    }
  ]
}

Return ONLY valid JSON. No explanation, no markdown fences.`
