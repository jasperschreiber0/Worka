/**
 * intake-worker — AI extraction pipeline for uploaded plans
 *
 * Runs outside Vercel so there is no 300 s serverless timeout.
 * Called by POST /api/intake/[fileId]/worker after the file is uploaded.
 *
 * Input:  POST { file_id: string, job_id: string, builder_id: string }
 * Output: { quote_id: string, assumption_count: number } on success
 *         { error: string } on failure
 *
 * Side-effects:
 *   files            → intake_status: 'processing' → 'extracted' | 'failed'
 *   quotes           → inserts draft quote row
 *   quote_line_items → inserts extracted line items
 *   assumptions      → inserts unresolved assumptions
 */

import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.24.0'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.43.0'

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
}

// ─── Trade categories (immutable — sort_order 1–13) ───────────────────────────

const TRADE_CATEGORIES = [
  { id: 1, name: 'Site Works & Concrete' },
  { id: 2, name: 'Framing' },
  { id: 3, name: 'Roofing' },
  { id: 4, name: 'External Cladding' },
  { id: 5, name: 'Insulation' },
  { id: 6, name: 'Internal Linings' },
  { id: 7, name: 'Fit-out Carpentry' },
  { id: 8, name: 'Cabinetry' },
  { id: 9, name: 'Paint' },
  { id: 10, name: 'Flooring' },
  { id: 11, name: 'Fixtures & Tapware' },
  { id: 12, name: 'Electrical' },
  { id: 13, name: 'Preliminaries' },
]

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
${TRADE_CATEGORIES.map((c) => `${c.id}. ${c.name}`).join('\n')}

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

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const t0 = Date.now()

  // ── Env ─────────────────────────────────────────────────────────────────────
  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const serviceRoleKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')

  if (!supabaseUrl || !serviceRoleKey || !anthropicKey) {
    return json({ error: 'Missing required environment variables' }, 500)
  }

  // ── Auth — only accept service-role key (internal call from Next.js route) ──
  const authHeader = req.headers.get('authorization') ?? ''
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null
  if (token !== serviceRoleKey) {
    return json({ error: 'Unauthorized' }, 401)
  }

  // ── Parse body ───────────────────────────────────────────────────────────────
  let body: { file_id?: string; job_id?: string; builder_id?: string }
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { file_id, job_id, builder_id } = body
  if (!file_id || !builder_id) {
    return json({ error: 'file_id and builder_id are required' }, 400)
  }

  const supabase = createClient(supabaseUrl, serviceRoleKey)

  // ── STEP 1: Fetch file row ───────────────────────────────────────────────────
  const t1 = Date.now()
  console.log(`[intake-worker] STEP: fetch file row file_id=${file_id}`)

  const { data: fileRow, error: fileErr } = await supabase
    .from('files')
    .select('*')
    .eq('id', file_id)
    .single()

  console.log(`[intake-worker] STEP COMPLETE fetch file row elapsed=${Date.now() - t1}ms`)

  if (fileErr || !fileRow) {
    console.error('[intake-worker] File not found:', fileErr)
    return json({ error: 'File not found' }, 404)
  }

  // Guard: only the owning builder
  if (fileRow.builder_id !== builder_id) {
    return json({ error: 'Forbidden' }, 403)
  }

  // Mark processing (idempotent guard already in the Next.js route, but belt-and-suspenders)
  await supabase.from('files').update({ intake_status: 'processing' }).eq('id', file_id)

  try {
    // ── STEP 2: Download from Supabase Storage ─────────────────────────────────
    const t2 = Date.now()
    console.log(`[intake-worker] STEP: download file storage_path=${fileRow.storage_path}`)

    const { data: fileData, error: downloadErr } = await supabase.storage
      .from('plans')
      .download(fileRow.storage_path)

    console.log(
      `[intake-worker] STEP COMPLETE download file elapsed=${Date.now() - t2}ms size=${fileData?.size ?? 'unknown'}`
    )

    if (downloadErr || !fileData) {
      throw new Error(`Storage download failed: ${downloadErr?.message ?? 'no data'}`)
    }

    // ── STEP 3: Base64 encode ──────────────────────────────────────────────────
    const t3 = Date.now()
    console.log('[intake-worker] STEP: base64 encode')

    const fileBuffer = await fileData.arrayBuffer()
    const uint8 = new Uint8Array(fileBuffer)
    // Deno-compatible base64 encode (no Buffer)
    const base64Data = btoa(String.fromCharCode(...uint8))
    const isPdf = (fileRow.file_type as string) === 'pdf'

    console.log(
      `[intake-worker] STEP COMPLETE base64 encode bytes=${fileBuffer.byteLength} elapsed=${Date.now() - t3}ms`
    )

    // ── STEP 4: Anthropic extraction ───────────────────────────────────────────
    const t4 = Date.now()
    console.log('[intake-worker] STEP: anthropic extraction')

    const anthropic = new Anthropic({ apiKey: anthropicKey })

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messageContent: any[] = isPdf
      ? [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64Data },
          },
          { type: 'text', text: EXTRACTION_PROMPT },
        ]
      : [
          {
            type: 'image',
            source: { type: 'base64', media_type: 'image/jpeg', data: base64Data },
          },
          { type: 'text', text: EXTRACTION_PROMPT },
        ]

    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 4096,
      messages: [{ role: 'user', content: messageContent }],
    })

    const anthropicResponse =
      response.content[0].type === 'text' ? response.content[0].text : ''

    console.log(`[intake-worker] STEP COMPLETE anthropic extraction elapsed=${Date.now() - t4}ms`)

    // ── STEP 5: Parse + validate (3 gates) ────────────────────────────────────
    const t5 = Date.now()
    console.log('[intake-worker] STEP: parse and validate')

    type RawLineItem = {
      trade_category_id: number
      description: string
      quantity: number | null
      unit: string | null
      dimensions_string: string | null
      confidence: number
    }

    let lineItems: RawLineItem[] = []
    try {
      const parsed = JSON.parse(anthropicResponse) as { line_items?: RawLineItem[] }
      lineItems = parsed.line_items ?? []
    } catch {
      // Malformed JSON — all items become assumptions
      lineItems = []
    }

    const assumptions: Array<{ description: string; gate: number; message: string }> = []

    const validatedItems = lineItems.map((item) => {
      let isAssumption = false
      let assumptionMessage: string | null = null
      let assumptionStatus: 'unresolved' | 'excluded' = 'unresolved'

      // Gate 1: No unit
      if (!item.unit) {
        isAssumption = true
        assumptionMessage = `Quantity unit not specified — please confirm the unit for ${item.description}`
        assumptions.push({ description: item.description, gate: 1, message: assumptionMessage })
      }
      // Gate 2: No dimensions when quantity present
      else if (item.quantity !== null && !item.dimensions_string) {
        isAssumption = true
        assumptionMessage = `Quantity could not be verified from plans — confirm ${item.quantity} ${item.unit} for ${item.description}`
        assumptions.push({ description: item.description, gate: 2, message: assumptionMessage })
      }
      // Gate 3: Zero or negative quantity
      else if (item.quantity !== null && item.quantity <= 0) {
        isAssumption = true
        assumptionStatus = 'excluded'
        assumptionMessage = `Invalid quantity (${item.quantity}) for ${item.description} — excluded from quote`
        assumptions.push({ description: item.description, gate: 3, message: assumptionMessage })
      }

      return {
        ...item,
        is_assumption: isAssumption,
        assumption_status: isAssumption ? assumptionStatus : null,
      }
    })

    console.log(
      `[intake-worker] STEP COMPLETE parse items=${validatedItems.length} assumptions=${assumptions.length} elapsed=${Date.now() - t5}ms`
    )

    // ── STEP 6: Write quote + line items + assumptions ─────────────────────────
    const t6 = Date.now()
    console.log('[intake-worker] STEP: write quote to database')

    const { data: quoteRow, error: quoteErr } = await supabase
      .from('quotes')
      .insert({
        job_id: job_id ?? null,
        builder_id,
        status: 'draft',
        total_cost: null,
        margin_pct: null,
        confidence_score: null,
        version: 1,
      })
      .select()
      .single()

    if (quoteErr || !quoteRow) {
      throw new Error(`Failed to insert quote: ${quoteErr?.message ?? 'no row'}`)
    }

    if (validatedItems.length > 0) {
      const lineItemInserts = validatedItems
        .filter((i) => i.assumption_status !== 'excluded')
        .map((i) => ({
          quote_id: quoteRow.id,
          trade_category_id: i.trade_category_id,
          description: i.description,
          quantity: i.quantity,
          unit: i.unit,
          rate: null,
          total: null,
          confidence: i.confidence,
          dimensions_string: i.dimensions_string,
          is_assumption: i.is_assumption,
          assumption_status: i.assumption_status ?? null,
        }))

      const { data: insertedItems } = await supabase
        .from('quote_line_items')
        .insert(lineItemInserts)
        .select()

      if (insertedItems && assumptions.length > 0) {
        await supabase.from('assumptions').insert(
          assumptions.map((a) => ({
            quote_id: quoteRow.id,
            line_item_id:
              insertedItems.find((li) => li.description === a.description)?.id ?? null,
            description: a.message,
            resolution_type: null,
            resolved_at: null,
            resolved_by: null,
          }))
        )
      }
    }

    // Mark file as extracted
    await supabase
      .from('files')
      .update({ intake_status: 'extracted', quote_id: quoteRow.id })
      .eq('id', file_id)

    const unresolvedCount = assumptions.filter((a) => a.gate !== 3).length

    console.log(
      `[intake-worker] STEP COMPLETE write database elapsed=${Date.now() - t6}ms`
    )
    console.log(
      `[intake-worker] DONE quote_id=${quoteRow.id} assumptions=${unresolvedCount} total_elapsed=${Date.now() - t0}ms`
    )

    return json({ quote_id: quoteRow.id, assumption_count: unresolvedCount })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error(`[intake-worker] FAILED elapsed=${Date.now() - t0}ms`, msg)

    // Best-effort: mark file as failed
    await supabase.from('files').update({ intake_status: 'failed' }).eq('id', file_id)

    return json({ error: 'Extraction failed', detail: msg }, 500)
  }
})
