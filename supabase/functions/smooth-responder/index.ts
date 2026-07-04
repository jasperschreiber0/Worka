/**
 * intake-pipeline — Layer 2 Decision (Backend)
 *
 * Runs the full PDF → quote extraction pipeline inside Supabase (no timeout).
 * Accepts POST { file_id, job_id, builder_id }, returns 202 immediately and
 * does the heavy work via EdgeRuntime.waitUntil so the caller isn't blocked.
 *
 * Progress is written to files.intake_stage / intake_pct so the Next.js SSE
 * poller can relay it to the UI without holding a long-lived Vercel connection.
 */

import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.24.0'
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

// ─── CORS ─────────────────────────────────────────────────────────────────────

const CORS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

// ─── Progress stages ──────────────────────────────────────────────────────────

const STAGES = [
  { stage: 'uploading',            pct: 5  },
  { stage: 'reading',              pct: 15 },
  { stage: 'analysing',            pct: 30 },
  { stage: 'extracting_site',      pct: 40 },
  { stage: 'extracting_framing',   pct: 50 },
  { stage: 'extracting_roofing',   pct: 58 },
  { stage: 'extracting_fitout',    pct: 68 },
  { stage: 'extracting_electrical',pct: 78 },
  { stage: 'validating',           pct: 88 },
  { stage: 'building_quote',       pct: 95 },
]

// ─── Trade categories ─────────────────────────────────────────────────────────

const TRADE_CATEGORIES = [
  { id: 1,  name: 'Site Works & Concrete'  },
  { id: 2,  name: 'Framing'                },
  { id: 3,  name: 'Roofing'                },
  { id: 4,  name: 'External Cladding'      },
  { id: 5,  name: 'Insulation'             },
  { id: 6,  name: 'Internal Linings'       },
  { id: 7,  name: 'Fit-out Carpentry'      },
  { id: 8,  name: 'Cabinetry'              },
  { id: 9,  name: 'Paint'                  },
  { id: 10, name: 'Flooring'               },
  { id: 11, name: 'Fixtures & Tapware'     },
  { id: 12, name: 'Electrical'             },
  { id: 13, name: 'Preliminaries'          },
]

// Base64-encode an ArrayBuffer in chunks. Spreading a whole multi-MB byte
// array into String.fromCharCode(...) overflows the call stack
// (RangeError: Maximum call stack size exceeded), so process it in slices.
function toBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer)
  const CHUNK = 0x8000 // 32K args per call — safely under the stack limit
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

async function runPipeline(
  fileId: string,
  jobId: string,
  builderId: string,
  supabase: ReturnType<typeof createClient>,
  anthropic: Anthropic,
) {
  const setStage = async (idx: number) => {
    const { stage, pct } = STAGES[idx]
    await supabase
      .from('files')
      .update({ intake_stage: stage, intake_pct: pct })
      .eq('id', fileId)
  }

  const fail = async () => {
    await supabase
      .from('files')
      .update({ intake_status: 'failed', intake_stage: 'failed', intake_pct: 0 })
      .eq('id', fileId)
  }

  try {
    // Stage 0: uploading (already in DB as 'uploaded', just update stage label)
    await setStage(0)

    // Fetch file record
    const { data: fileRow, error: fileErr } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .single()

    if (fileErr || !fileRow) { await fail(); return }

    await supabase.from('files').update({ intake_status: 'processing' }).eq('id', fileId)

    // Stage 1: reading
    await setStage(1)

    const { data: fileData, error: downloadErr } = await supabase.storage
      .from('plans')
      .download(fileRow.storage_path)

    if (downloadErr || !fileData) { await fail(); return }

    // Stage 2: analysing
    await setStage(2)

    const fileBuffer = await fileData.arrayBuffer()
    const base64Data = toBase64(fileBuffer)
    const isPdf = fileRow.file_type === 'pdf'

    const extractionPrompt = `You are a quantity surveyor AI for Australian residential construction.

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

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const messageContent: any[] = isPdf
      ? [
          { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } },
          { type: 'text', text: extractionPrompt },
        ]
      : [
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64Data } },
          { type: 'text', text: extractionPrompt },
        ]

    // Emit extraction stages while waiting for Anthropic (best-effort timing)
    const stageIndices = [3, 4, 5, 6, 7]
    let stageIdx = 0
    const stageInterval = setInterval(async () => {
      if (stageIdx < stageIndices.length) {
        await setStage(stageIndices[stageIdx++])
      }
    }, 2000)

    let anthropicResponse = ''
    try {
      const response = await anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 4096,
        messages: [{ role: 'user', content: messageContent }],
      })
      anthropicResponse = response.content[0].type === 'text' ? response.content[0].text : ''
    } finally {
      clearInterval(stageInterval)
    }

    // Ensure all extraction stages recorded
    for (; stageIdx < stageIndices.length; stageIdx++) {
      await setStage(stageIndices[stageIdx])
    }

    // Stage 8: validating
    await setStage(8)

    let lineItems: Array<{
      trade_category_id: number
      description: string
      quantity: number | null
      unit: string | null
      dimensions_string: string | null
      confidence: number
    }> = []

    try {
      const parsed = JSON.parse(anthropicResponse)
      lineItems = parsed.line_items ?? []
    } catch {
      lineItems = []
    }

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

    // Stage 9: building_quote
    await setStage(9)

    const { data: quoteRow, error: quoteErr } = await supabase
      .from('quotes')
      .insert({ job_id: jobId, builder_id: builderId, status: 'draft', total_cost: null, margin_pct: null, confidence_score: null, version: 1 })
      .select()
      .single()

    if (quoteErr || !quoteRow) { await fail(); return }

    if (validatedItems.length > 0) {
      const lineItemInserts = validatedItems
        .filter((item) => item.assumption_status !== 'excluded')
        .map((item) => ({
          quote_id: quoteRow.id,
          trade_category_id: item.trade_category_id,
          description: item.description,
          quantity: item.quantity,
          unit: item.unit,
          rate: null,
          total: null,
          confidence: item.confidence,
          dimensions_string: item.dimensions_string,
          is_assumption: item.is_assumption,
          assumption_status: item.assumption_status ?? null,
        }))

      const { data: insertedItems } = await supabase
        .from('quote_line_items')
        .insert(lineItemInserts)
        .select()

      if (insertedItems && assumptions.length > 0) {
        const assumptionInserts = assumptions.map((a) => {
          const matchingItem = insertedItems.find((li) => li.description === a.description)
          return {
            quote_id: quoteRow.id,
            line_item_id: matchingItem?.id ?? null,
            description: a.message,
            resolution_type: null,
            resolved_at: null,
            resolved_by: null,
          }
        })
        await supabase.from('assumptions').insert(assumptionInserts)
      }
    }

    const unresolvedCount = assumptions.filter((a) => a.gate !== 3).length

    await supabase
      .from('files')
      .update({
        intake_status: 'extracted',
        intake_stage: 'complete',
        intake_pct: 100,
        quote_id: quoteRow.id,
        intake_assumption_count: unresolvedCount,
      })
      .eq('id', fileId)

  } catch (err) {
    console.error('intake-pipeline error:', err)
    await fail()
  }
}

// ─── Handler ──────────────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: CORS })
  if (req.method !== 'POST') {
    return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const supabaseUrl = Deno.env.get('SUPABASE_URL')
  const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')
  // Trim so a secret stored with a trailing newline/whitespace doesn't produce
  // a spurious `401 invalid x-api-key` from Anthropic. Still required — an
  // empty/undefined key falls through to the 500 guard below.
  const anthropicKey = Deno.env.get('ANTHROPIC_API_KEY')?.trim()

  if (!supabaseUrl || !supabaseKey || !anthropicKey) {
    return new Response(JSON.stringify({ error: 'Missing environment variables' }), { status: 500, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  let body: { file_id: string; job_id: string; builder_id: string }
  try {
    body = await req.json()
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const { file_id, job_id, builder_id } = body
  if (!file_id || !job_id || !builder_id) {
    return new Response(JSON.stringify({ error: 'file_id, job_id, builder_id required' }), { status: 400, headers: { ...CORS, 'Content-Type': 'application/json' } })
  }

  const supabase = createClient(supabaseUrl, supabaseKey)
  const anthropic = new Anthropic({ apiKey: anthropicKey })

  // Fire pipeline in background; return 202 immediately so the caller isn't blocked
  EdgeRuntime.waitUntil(runPipeline(file_id, job_id, builder_id, supabase, anthropic))

  return new Response(JSON.stringify({ status: 'started' }), {
    status: 202,
    headers: { ...CORS, 'Content-Type': 'application/json' },
  })
})
