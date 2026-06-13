import { NextRequest } from 'next/server'
import type { ProjectMetadata, SimilarProject, ScopeHint, BuilderEstimationProfile } from '@/lib/types/estimation.types'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

// Streaming AI extraction can take several minutes on large plan sets —
// without this Vercel kills the function mid-stream.
export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ─── Types ────────────────────────────────────────────────────────────────────

interface ProgressEvent {
  stage: string
  message: string
  pct: number
}

interface CompleteEvent {
  stage: 'complete'
  message: string
  pct: 100
  quote_id: string
  assumption_count: number
  similar_projects?: SimilarProject[]
  scope_hints?: ScopeHint[]
  total_in_memory?: number
}

interface ExtractionDiag {
  file_id: string
  doc_blocks_sent: number
  primary_response_length: number
  primary_response_sample: string
  primary_parse: 'success' | 'json_failed' | 'empty_array'
  primary_parse_error: string | null
  primary_truncated: boolean
  primary_had_fence: boolean
  retry_attempted: boolean
  retry_reason?: string
  retry_response_length?: number
  retry_parse?: 'success' | 'json_failed' | 'empty_array'
  retry_parse_error?: string | null
  retry_truncated?: boolean
  final_line_items: number
  used_prefill: boolean
  model: string
  timestamp: string
}

// ─── Failure stages + user-facing messages ────────────────────────────────────

type FailureStage =
  | 'FILE_DOWNLOAD_FAILED'
  | 'PDF_PARSE_FAILED'
  | 'PASSWORD_PROTECTED_PDF'
  | 'OCR_FAILED'
  | 'NO_TEXT_EXTRACTED'
  | 'DOCUMENT_TOO_SMALL'
  | 'AI_EXTRACTION_FAILED'
  | 'AI_NO_OUTPUT'
  | 'AI_INVALID_JSON'
  | 'AI_SCHEMA_MISMATCH'
  | 'AI_TRUNCATED_OUTPUT'
  | 'JSON_PARSE_FAILED'
  | 'NO_LINE_ITEMS_FOUND'

const FAILURE_MESSAGES: Record<FailureStage, string> = {
  FILE_DOWNLOAD_FAILED:    'We couldn\'t retrieve this file. Please try uploading it again.',
  PDF_PARSE_FAILED:        'The file could not be read — it may be corrupt or in an unsupported format.',
  PASSWORD_PROTECTED_PDF:  'This PDF is password-protected. Remove the password and re-upload.',
  OCR_FAILED:              'We couldn\'t extract text from this PDF. It may be a scanned image or low-resolution document.',
  NO_TEXT_EXTRACTED:       'We couldn\'t extract text from this PDF. It may be a scanned image or low-resolution document.',
  DOCUMENT_TOO_SMALL:      'This file appears too small to be a building plan. Please check you\'ve uploaded the correct document.',
  AI_EXTRACTION_FAILED:    'The document was read successfully, but WorkA couldn\'t identify quoteable building items.',
  AI_NO_OUTPUT:            'The AI returned an empty response. Please try again.',
  AI_INVALID_JSON:         'The AI returned malformed JSON on both attempts. Please try again — if it keeps failing, re-export the PDF.',
  AI_SCHEMA_MISMATCH:      'The AI returned an unexpected data structure. Please try again.',
  AI_TRUNCATED_OUTPUT:     'The AI response was cut off before completing. Try uploading fewer pages at once.',
  JSON_PARSE_FAILED:       'The AI returned an unexpected response format. Please try again — if it keeps failing, the file may need to be re-exported.',
  NO_LINE_ITEMS_FOUND:     'The document appears valid, but no measurable construction items were detected. Check that the file contains a quantity schedule or annotated plans.',
}


// ─── Progress stages ──────────────────────────────────────────────────────────

const PROGRESS_STAGES: ProgressEvent[] = [
  { stage: 'uploading',          message: 'Uploading plans...',                      pct: 5  },
  { stage: 'reading',            message: 'Reading file...',                         pct: 12 },
  { stage: 'analysing',          message: 'Analysing plans with AI...',              pct: 22 },
  { stage: 'retrieving_memory',  message: 'Searching historical projects...',        pct: 35 },
  { stage: 'extracting_site',    message: 'Extracting site works & concrete...',     pct: 44 },
  { stage: 'extracting_framing', message: 'Extracting framing quantities...',        pct: 52 },
  { stage: 'extracting_roofing', message: 'Extracting roofing...',                   pct: 60 },
  { stage: 'extracting_fitout',  message: 'Extracting fit-out & finishes...',        pct: 68 },
  { stage: 'extracting_elec',    message: 'Extracting electrical & prelims...',      pct: 76 },
  { stage: 'scope_intelligence', message: 'Detecting likely missing scope items...', pct: 84 },
  { stage: 'validating',         message: 'Running quantity validation gates...',    pct: 90 },
  { stage: 'building_quote',     message: 'Building draft quote...',                 pct: 96 },
]

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function sseEvent(encoder: TextEncoder, event: string, data: object): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Metadata extraction prompt ───────────────────────────────────────────────

const METADATA_PROMPT = `Analyse these building plans and extract the following project metadata. Return ONLY valid JSON:
{
  "job_type": "rear_extension|side_extension|bathroom_reno|kitchen_reno|double_storey|granny_flat|new_build|knockdown_rebuild|full_renovation|deck_pergola|other",
  "renovation_type": "extension|renovation|new_build|addition|alteration|knockdown_rebuild",
  "project_summary": "1-2 sentence plain English description of the project",
  "floor_area_m2": number or null,
  "storeys": integer or null,
  "wet_areas": integer or null,
  "bedrooms": integer or null,
  "finish_level": "budget|standard|premium|luxury",
  "construction_type": "timber_frame|steel_frame|double_brick|brick_veneer|other",
  "region": "NSW|VIC|QLD|SA|WA|TAS|ACT|NT" or null,
  "suburb": "suburb name if visible" or null
}`

// ─── Quantity extraction prompt (memory-enhanced) ─────────────────────────────

function buildExtractionPrompt(
  similarProjects: SimilarProject[],
  builderProfile: BuilderEstimationProfile | null,
  projectSummary: string,
  documentCount = 1
): string {
  const tradeCategories = [
    { id: 1,  name: 'Earthworks & Site Prep' },
    { id: 2,  name: 'Concrete' },
    { id: 3,  name: 'Framing & Structural' },
    { id: 4,  name: 'Roofing' },
    { id: 5,  name: 'Windows & External Doors' },
    { id: 6,  name: 'External Cladding' },
    { id: 7,  name: 'Insulation' },
    { id: 8,  name: 'Internal Linings' },
    { id: 9,  name: 'Joinery & Cabinetry' },
    { id: 10, name: 'Painting' },
    { id: 11, name: 'Plumbing' },
    { id: 12, name: 'Electrical' },
    { id: 13, name: 'Tiling & Finishes' },
  ]

  let historicalContext = ''
  if (similarProjects.length > 0) {
    historicalContext = `\nHISTORICAL CONTEXT — ${similarProjects.length} similar completed project${similarProjects.length > 1 ? 's' : ''}:
${similarProjects.map(p =>
  `• ${p.project_summary} (${p.floor_area_m2 ?? '?'}sqm, quoted ${p.quoted_cost ? `$${p.quoted_cost.toLocaleString()}` : 'unknown'}${p.final_cost ? `, final $${p.final_cost.toLocaleString()}` : ''})`
).join('\n')}`
  }

  let profileContext = ''
  if (builderProfile && builderProfile.quotes_generated > 0) {
    profileContext = `\nBUILDER PROFILE:
• Typical margin: ${builderProfile.typical_margin_pct}%
• Finish level: ${builderProfile.finish_level}
• Historical adjustment: typically ${builderProfile.adjustment_direction ?? 'neutral'} by ${builderProfile.avg_adjustment_pct ? Math.abs(builderProfile.avg_adjustment_pct) + '%' : 'unknown'}
• Quote accuracy: ${builderProfile.avg_quote_accuracy_pct ? builderProfile.avg_quote_accuracy_pct + '%' : 'insufficient data'}`
  }

  const docNote = documentCount > 1
    ? `You have been provided ${documentCount} documents (plans, drawings, schedules). Cross-reference all of them together to produce the most complete and accurate takeoff.`
    : 'You have been provided one document.'

  return `You are a senior quantity surveyor with 20 years of Australian residential construction experience. You are thorough, precise, and never leave a trade category empty if there is any evidence in the plans.

PROJECT:
${projectSummary}
${historicalContext}
${profileContext}

${docNote}

Your task: produce a complete, accurate construction cost takeoff from the provided documents. This will be used to generate a real builder's quote — accuracy and completeness are critical.

Instructions:
1. Read ALL provided documents carefully before extracting quantities.
2. Extract EVERY measurable item. Do not skip trades because information is partial — use your professional judgement to estimate where plans are unclear, and set confidence accordingly.
3. For each trade category, produce multiple line items (not just one). A bathroom reno should have separate lines for waterproofing, tiling floor, tiling walls, vanity, toilet, shower screen, tapware, etc.
4. Use Australian construction rates and terminology (e.g. "m²" not "sf", "LM" not "LF", dollars in AUD).
5. Where quantities can be calculated from dimensions shown in plans, do the calculation and show the working in dimensions_string.
6. Never invent quantities you cannot support — set confidence low and note the assumption instead.
7. Every item that appears in a schedule, legend, or specification must be captured.

For each line item provide:
- trade_category_id (1–13)
- description (specific item name — e.g. "Concrete slab — ground floor, 125mm thick" not just "Concrete")
- quantity (numeric — calculate from dimensions where possible, or null if truly indeterminate)
- unit (m², lm, ea, m³, hr — or null)
- dimensions_string (show the calculation: "14.2m × 8.6m = 122.1m²" — or null)
- confidence (0–100: 95+=scaled from plans, 70–94=estimated from project type, 40–69=professional assumption, <40=flagged for review)
- subcategory_code (e.g. "ELEC-POWER", "TILE-FLOOR")
- pricing_type: "measured" | "pc_allowance" | "provisional_sum"
- source_ref: drawing/schedule reference (e.g. "A3.1", "Roof Plan", "Door Schedule") or null
- labour_cost: AUD labour component estimate or null
- material_cost: AUD materials component estimate or null
- subcontract_cost: AUD subcontractor component estimate or null
- plant_cost: AUD plant/equipment component estimate or null

Trade categories:
${tradeCategories.map(c => `${c.id}. ${c.name}`).join('\n')}

${historicalContext ? 'IMPORTANT: Use the historical projects as your benchmark. If your quantities produce a total substantially different from similar completed jobs, re-check your takeoff before finalising.' : ''}

STRICT OUTPUT RULE:
- Output ONLY the JSON object. Nothing before it. Nothing after it.
- Do NOT use markdown, backticks, or code fences.
- Do NOT add explanations, headings, or commentary.
- Start your response with { and end with }
- All string values must use double quotes (never single quotes).
- Unknown values must be null — never omit a key.
- pricing_type must be exactly one of: "measured", "pc_allowance", or "provisional_sum"

Output this exact structure (values are examples — replace with real extracted data):
{"line_items":[{"trade_category_id":3,"description":"Wall framing — 90mm MGP10 timber studs at 450mm centres","quantity":145.6,"unit":"m²","dimensions_string":"14.2m × 8.6m = 122.1m²","confidence":85,"subcategory_code":"FRAM-WALL","pricing_type":"measured","source_ref":"A3.1","labour_cost":4200,"material_cost":3800,"subcontract_cost":null,"plant_cost":null}],"confidence_summary":"High confidence — quantities scaled directly from dimensioned plans"}`
}

// ─── JSON extraction helper ───────────────────────────────────────────────────

interface ParseResult {
  data: { line_items: unknown[]; confidence_summary: string } | null
  error: string | null
  truncated: boolean
  had_fence: boolean
}

function tryExtractJson(raw: string): ParseResult {
  const fail = (error: string, truncated = false, had_fence = false): ParseResult =>
    ({ data: null, error, truncated, had_fence })

  if (!raw || raw.length < 10) return fail('empty_response')

  let text = raw.trim()
  let had_fence = false

  // Strip markdown fences (```json ... ``` or ``` ... ```)
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { text = fence[1].trim(); had_fence = true }

  // Find outermost JSON object boundaries
  const start = text.indexOf('{')
  if (start < 0) return fail('no_opening_brace', false, had_fence)

  const end = text.lastIndexOf('}')
  // Closing brace absent or before opening brace — response was truncated
  if (end <= start) return fail('truncated_no_closing_brace', true, had_fence)

  text = text.slice(start, end + 1)

  // Strip trailing commas before ] or } — common LLM formatting mistake
  text = text.replace(/,(\s*[}\]])/g, '$1')

  try {
    const parsed = JSON.parse(text)
    if (!parsed || typeof parsed !== 'object') return fail('not_an_object', false, had_fence)
    const line_items = Array.isArray(parsed.line_items) ? parsed.line_items : []
    return {
      data: { line_items, confidence_summary: String(parsed.confidence_summary ?? '') },
      error: null,
      truncated: false,
      had_fence,
    }
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'json_parse_error', false, had_fence)
  }
}

// ─── Build explainability from line items + similar projects ──────────────────

function buildExplainability(
  lineItems: Array<{ trade_category_id: number; quantity: number | null; unit: string | null; confidence: number }>,
  similarProjects: SimilarProject[],
  metadata: ProjectMetadata
) {
  const TRADE_NAMES: Record<number, string> = {
    1: 'Earthworks & Site Prep', 2: 'Concrete', 3: 'Framing & Structural',
    4: 'Roofing', 5: 'Windows & External Doors', 6: 'External Cladding',
    7: 'Insulation', 8: 'Internal Linings', 9: 'Joinery & Cabinetry',
    10: 'Painting', 11: 'Plumbing', 12: 'Electrical', 13: 'Tiling & Finishes',
  }

  // Group by trade
  const byTrade = new Map<number, typeof lineItems>()
  for (const item of lineItems) {
    if (!byTrade.has(item.trade_category_id)) byTrade.set(item.trade_category_id, [])
    byTrade.get(item.trade_category_id)!.push(item)
  }

  return Array.from(byTrade.entries()).map(([tradeId, items]) => {
    const avgConfidence = Math.round(items.reduce((s, i) => s + i.confidence, 0) / items.length)
    const drivers: string[] = []

    if (metadata.floor_area_m2) drivers.push(`${metadata.floor_area_m2}sqm build area`)
    if (metadata.region) drivers.push(`${metadata.region} regional pricing`)
    if (items.length > 0) drivers.push(`${items.length} line item${items.length !== 1 ? 's' : ''} extracted from plans`)

    let similarRange: string | null = null
    if (similarProjects.length >= 2) {
      similarRange = `Informed by ${similarProjects.length} similar completed project${similarProjects.length > 1 ? 's' : ''}`
    }

    return {
      trade_category_id: tradeId,
      trade_category_name: TRADE_NAMES[tradeId] ?? `Trade ${tradeId}`,
      estimated_cost: 0, // populated after pricing step
      confidence: avgConfidence,
      similar_project_range: similarRange,
      historical_accuracy: null,
      key_drivers: drivers,
    }
  })
}

// ─── GET /api/intake/[fileId] ─────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: { fileId: string } }
): Promise<Response> {
  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const { fileId } = params
  const { searchParams } = new URL(req.url)
  const job_id = searchParams.get('job_id') ?? ''
  const siblingsParam = searchParams.get('siblings') ?? ''
  const siblingFileIds = siblingsParam ? siblingsParam.split(',').filter(Boolean) : []

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY

  // Real mode requires Anthropic key + file data available (via memory cache OR Supabase).
  // We no longer require Supabase Storage — files are cached in memory at upload time.
  const { getCachedFile } = await import('@/lib/file-cache')
  const hasFileData = Boolean(getCachedFile(fileId)) || Boolean(supabaseUrl && supabaseKey)
  const isRealMode = Boolean(anthropicKey && hasFileData)

  const encoder = new TextEncoder()

  // ── Demo mode ──────────────────────────────────────────────────────────────
  if (!isRealMode) {
    const { DEMO_PROJECT_MEMORY, DEMO_SCOPE_HINTS } = await import('@/lib/estimation-demo')
    const stream = new ReadableStream({
      async start(controller) {
        try {
          // Emit all stages with delays
          for (let i = 0; i < PROGRESS_STAGES.length; i++) {
            await delay(i === 3 ? 1200 : i === 9 ? 1000 : 600)
            controller.enqueue(sseEvent(encoder, 'progress', PROGRESS_STAGES[i]))
          }

          await delay(600)

          const completeData: CompleteEvent = {
            stage: 'complete',
            message: 'Draft quote ready — 3 assumptions need your review.',
            pct: 100,
            quote_id: 'demo-quote-id',
            assumption_count: 3,
            similar_projects: DEMO_PROJECT_MEMORY.slice(0, 4),
            scope_hints: DEMO_SCOPE_HINTS,
            total_in_memory: DEMO_PROJECT_MEMORY.length,
          }
          controller.enqueue(sseEvent(encoder, 'complete', completeData))
          controller.close()
        } catch (err) {
          controller.error(err)
        }
      },
    })

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      },
    })
  }

  // ── Real mode ──────────────────────────────────────────────────────────────
  const stream = new ReadableStream({
    async start(controller) {
      const pipelineStart = Date.now()

      const emit = (event: string, data: object) => {
        controller.enqueue(sseEvent(encoder, event, data))
      }

      // Supabase declared here so failWith can capture it via closure
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let supabase: any = null

      // Metrics accumulated during the run — written to DB on both success and failure
      let extractedTextLength = 0

      // Fail the pipeline at a named stage: logs, updates DB, emits error, closes stream
      const failWith = async (
        stage: FailureStage,
        internalReason: string,
        extra?: { line_item_count?: number; page_count?: number }
      ) => {
        const processingTimeMs = Date.now() - pipelineStart
        console.error('[intake:fail]', {
          file_id: fileId,
          stage,
          reason: internalReason,
          processing_time_ms: processingTimeMs,
          extracted_text_length: extractedTextLength || null,
          ...extra,
        })
        if (supabase) {
          const { error: dbErr } = await supabase.from('files').update({
            intake_status: 'failed',
            failure_stage: stage,
            failure_reason: internalReason.slice(0, 500),
            processing_time_ms: processingTimeMs,
            extracted_text_length: extractedTextLength || null,
            ...(extra?.line_item_count != null && { line_item_count: extra.line_item_count }),
            ...(extra?.page_count != null && { page_count: extra.page_count }),
          }).eq('id', fileId)
          if (dbErr) console.error('[intake] DB fail-update error:', dbErr.message)
        }
        emit('error', { message: FAILURE_MESSAGES[stage], stage })
        controller.close()
      }

      try {
        emit('progress', PROGRESS_STAGES[0]) // uploading

        const Anthropic = (await import('@anthropic-ai/sdk')).default
        const client = new Anthropic({ apiKey: anthropicKey })

        // Supabase is optional — memory cache is the primary file source
        const hasSupabase = Boolean(supabaseUrl && supabaseKey)
        if (hasSupabase) {
          const { createClient } = await import('@supabase/supabase-js')
          supabase = createClient(supabaseUrl!, supabaseKey!)
        }

        // Fetch file record from DB if Supabase available — otherwise proceed with cache only
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let fileRow: any = null
        if (supabase) {
          const { data, error: fileErr } = await supabase
            .from('files')
            .select('*')
            .eq('id', fileId)
            .eq('builder_id', builder_id)
            .single()
          if (!fileErr) fileRow = data
          const { error: processingErr } = await supabase.from('files').update({ intake_status: 'processing' }).eq('id', fileId)
          if (processingErr) console.error('[intake] status→processing:', processingErr.message)
        }

        emit('progress', PROGRESS_STAGES[1]) // reading

        // ── Load primary file — check memory cache first, then Supabase Storage ──
        const { getCachedFile } = await import('@/lib/file-cache')
        const cached = getCachedFile(fileId)

        let base64Data: string
        let primaryMediaType: string

        if (cached) {
          base64Data = cached.base64
          primaryMediaType = cached.mediaType
        } else {
          if (!fileRow) {
            await failWith('FILE_DOWNLOAD_FAILED', 'File record not found — upload may not have completed')
            return
          }

          const { data: fileData, error: downloadErr } = await supabase.storage
            .from('plans')
            .download(fileRow.storage_path)

          if (downloadErr || !fileData) {
            const storageMsg = (downloadErr as { message?: string } | null)?.message ?? 'unknown'
            await failWith('FILE_DOWNLOAD_FAILED', `Storage download failed: ${storageMsg}`)
            return
          }

          const fileBuffer = await fileData.arrayBuffer()
          base64Data = Buffer.from(fileBuffer).toString('base64')
          primaryMediaType = fileRow?.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg'
        }

        emit('progress', PROGRESS_STAGES[2]) // analysing

        const detectedMediaType = cached?.mediaType ?? primaryMediaType ?? ''
        const isPdf = detectedMediaType.includes('pdf') || fileRow?.file_type === 'pdf'
        const isCsv = detectedMediaType.includes('csv') || detectedMediaType.includes('text/plain')
          || fileRow?.filename?.toLowerCase().endsWith('.csv')
        const mediaType = isPdf ? 'application/pdf' : 'image/jpeg'

        // Reject files that are clearly too small to contain a building plan.
        // base64 → raw bytes ≈ length × 0.75.  Threshold: 8 KB for PDFs/images.
        const rawBytes = Math.ceil(base64Data.length * 0.75)
        console.log('[intake:file]', { file_id: fileId, media_type: detectedMediaType, raw_bytes: rawBytes, is_pdf: isPdf, is_csv: isCsv })
        if (!isCsv && rawBytes < 8192) {
          await failWith('DOCUMENT_TOO_SMALL', `File is only ${rawBytes} bytes — too small for a building plan`)
          return
        }

        // CSV: decode as UTF-8 text and inject as a text block
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let docBlock: any
        if (isCsv) {
          const csvText = Buffer.from(base64Data, 'base64').toString('utf-8')
          extractedTextLength = csvText.length
          console.log('[intake:csv]', { file_id: fileId, text_length: extractedTextLength })
          docBlock = { type: 'text', text: `CSV FILE CONTENTS:\n\`\`\`\n${csvText.slice(0, 60000)}\n\`\`\`` }
        } else if (isPdf) {
          docBlock = { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Data } }
        } else {
          docBlock = { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } }
        }

        // Load sibling files — check memory cache first, then Supabase Storage.
        // Anthropic caps requests at 32MB total, so budget raw bytes across all
        // attached documents and skip siblings that don't fit rather than
        // failing the entire request.
        const MAX_TOTAL_RAW_BYTES = 20 * 1024 * 1024
        let attachedRawBytes = Math.ceil(base64Data.length * 0.75)
        let skippedSiblingCount = 0
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const siblingBlocks: any[] = []
        for (const sibId of siblingFileIds.slice(0, 6)) { // support up to 6 siblings (7 total)
          try {
            const sibCached = getCachedFile(sibId)
            if (sibCached) {
              const sibIsCsv = sibCached.mediaType.includes('csv') || sibCached.mediaType.includes('text/plain') || sibCached.filename?.toLowerCase().endsWith('.csv')
              const sibIsPdf = sibCached.mediaType.includes('pdf')
              if (sibIsCsv) {
                const sibText = Buffer.from(sibCached.base64, 'base64').toString('utf-8')
                siblingBlocks.push({ type: 'text', text: `CSV FILE CONTENTS (${sibCached.filename ?? 'file'}):\n\`\`\`\n${sibText.slice(0, 30000)}\n\`\`\`` })
                continue
              }
              const sibRawBytes = Math.ceil(sibCached.base64.length * 0.75)
              if (attachedRawBytes + sibRawBytes > MAX_TOTAL_RAW_BYTES) {
                skippedSiblingCount++
                continue
              }
              attachedRawBytes += sibRawBytes
              siblingBlocks.push(
                sibIsPdf
                  ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: sibCached.base64 } }
                  : { type: 'image', source: { type: 'base64', media_type: sibCached.mediaType, data: sibCached.base64 } }
              )
              continue
            }
            if (!supabase) continue
            const { data: sibRow } = await supabase.from('files').select('*').eq('id', sibId).eq('builder_id', builder_id).single()
            if (!sibRow) continue
            const { data: sibData } = await supabase.storage.from('plans').download(sibRow.storage_path)
            if (!sibData) continue
            const sibBuffer = await sibData.arrayBuffer()
            if (attachedRawBytes + sibBuffer.byteLength > MAX_TOTAL_RAW_BYTES) {
              skippedSiblingCount++
              continue
            }
            attachedRawBytes += sibBuffer.byteLength
            const sibBase64 = Buffer.from(sibBuffer).toString('base64')
            const sibIsPdf = sibRow.file_type === 'pdf'
            siblingBlocks.push(
              sibIsPdf
                ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: sibBase64 } }
                : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sibBase64 } }
            )
          } catch {
            // Non-fatal — skip unreadable siblings
          }
        }

        // All document blocks for Claude calls (primary first, then siblings)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const allDocBlocks: any[] = [docBlock, ...siblingBlocks]

        // ── Step 1: Extract project metadata ─────────────────────────────────
        let projectMetadata: ProjectMetadata = {
          job_type: null, renovation_type: null, project_summary: 'Residential construction project',
          floor_area_m2: null, storeys: null, wet_areas: null, bedrooms: null,
          finish_level: null, construction_type: null, region: null, suburb: null,
        }

        try {
          // Metadata only needs the primary document — sending the full set
          // risks blowing the request size limit for a 512-token answer.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const metaResponse = await (client.messages.create as any)({
            model: 'claude-haiku-4-5-20251001',
            max_tokens: 512,
            messages: [{ role: 'user', content: [docBlock, { type: 'text', text: METADATA_PROMPT }] }],
          })
          const metaText = metaResponse.content[0]?.type === 'text' ? metaResponse.content[0].text : ''
          const metaMatch = metaText.match(/\{[\s\S]*\}/)
          if (metaMatch) {
            projectMetadata = { ...projectMetadata, ...JSON.parse(metaMatch[0]) }
          }
        } catch {
          // Non-fatal — continue with defaults
        }

        // ── Step 2: Retrieve similar historical projects ───────────────────
        emit('progress', PROGRESS_STAGES[3]) // retrieving_memory

        let similarProjects: SimilarProject[] = []
        let totalInMemory = 0

        try {
          const { data: memoryRows } = await supabase
            .from('project_memory')
            .select('*')
            .eq('builder_id', builder_id)
            .in('status', ['completed', 'active'])
            .order('completed_at', { ascending: false })
            .limit(50)

          totalInMemory = memoryRows?.length ?? 0

          if (memoryRows && memoryRows.length > 0) {
            // Score locally
            const scored = memoryRows.map((p: SimilarProject) => {
              let score = 0
              const reasons: string[] = []
              if (p.job_type === projectMetadata.job_type) { score += 30; reasons.push('Same job type') }
              if (p.floor_area_m2 && projectMetadata.floor_area_m2) {
                const diff = Math.abs(p.floor_area_m2 - projectMetadata.floor_area_m2) / projectMetadata.floor_area_m2
                if (diff < 0.2) { score += 15; reasons.push('Similar floor area') }
                else if (diff < 0.35) { score += 8 }
              }
              if (p.region === projectMetadata.region) { score += 15; reasons.push('Same state') }
              if (p.finish_level === projectMetadata.finish_level) { score += 15; reasons.push('Same finish level') }
              if (p.wet_areas !== null && projectMetadata.wet_areas !== null && Math.abs((p.wet_areas ?? 0) - (projectMetadata.wet_areas ?? 0)) <= 1) { score += 10 }
              if (p.storeys === projectMetadata.storeys) { score += 10 }
              return { ...p, similarity_score: Math.min(score, 100), similarity_reasons: reasons }
            }).filter((p: { similarity_score: number }) => p.similarity_score >= 50)
              .sort((a: { similarity_score: number }, b: { similarity_score: number }) => b.similarity_score - a.similarity_score)
              .slice(0, 5)

            similarProjects = scored
          }
        } catch {
          // Non-fatal
        }

        // ── Step 3: Fetch builder profile ─────────────────────────────────
        let builderProfile: BuilderEstimationProfile | null = null
        try {
          const { data: profileRow } = await supabase
            .from('builder_estimation_profiles')
            .select('*')
            .eq('builder_id', builder_id)
            .single()
          builderProfile = profileRow as BuilderEstimationProfile | null
        } catch {
          // Non-fatal
        }

        // ── Step 4: Memory-enhanced quantity extraction ────────────────────
        const extractionPrompt = buildExtractionPrompt(similarProjects, builderProfile, projectMetadata.project_summary, allDocBlocks.length)

        const stageIndices = [4, 5, 6, 7, 8]
        let stageIdx = 0
        const stageEmitter = setInterval(() => {
          if (stageIdx < stageIndices.length) {
            emit('progress', PROGRESS_STAGES[stageIndices[stageIdx]])
            stageIdx++
          } else {
            // Keep the SSE connection alive while Claude processes
            controller.enqueue(encoder.encode(': keepalive\n\n'))
          }
        }, 2000)

        // Assistant prefill forces the model to start mid-JSON, eliminating any
        // chance of preamble text or markdown fences before the object.
        const EXTRACTION_PREFILL = '{"line_items":['

        let anthropicResponse: string
        let usedPrefill = false
        let droppedToPrimaryOnly = false

        console.log('[intake:ai-prompt]', {
          file_id: fileId,
          doc_blocks: allDocBlocks.length,
          prompt_length: extractionPrompt.length,
          model: 'claude-sonnet-4-6',
          max_tokens: 8192,
          prefill: true,
        })

        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const callExtraction = async (blocks: any[], withPrefill = true): Promise<string> => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const messages: any[] = [{ role: 'user', content: [...blocks, { type: 'text', text: extractionPrompt }] }]
            if (withPrefill) {
              messages.push({ role: 'assistant', content: EXTRACTION_PREFILL })
            }
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const response = await (client.messages.create as any)({
              model: 'claude-sonnet-4-6',
              max_tokens: 8192,
              messages,
            })
            const completion: string = response.content[0]?.type === 'text' ? response.content[0].text : ''
            // Prepend the prefill so the combined string is valid JSON
            const text = withPrefill ? EXTRACTION_PREFILL + completion : completion
            console.log('[intake:ai-response]', {
              file_id: fileId,
              input_tokens: response.usage?.input_tokens ?? null,
              output_tokens: response.usage?.output_tokens ?? null,
              response_length: text.length,
              response_sample: text.slice(0, 200),
              prefill_used: withPrefill,
            })
            return text
          }

          try {
            anthropicResponse = await callExtraction(allDocBlocks, true)
            usedPrefill = true
          } catch (firstErr) {
            const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
            const isTooLarge = /request_too_large|too large|prompt is too long|too long|page limit|100 pages|413/i.test(firstMsg)
            if (isTooLarge && allDocBlocks.length > 1) {
              console.warn('[intake:ai-fallback]', { file_id: fileId, reason: 'too_large', retrying_with: 'primary_only', error: firstMsg })
              anthropicResponse = await callExtraction([docBlock], true)
              usedPrefill = true
              droppedToPrimaryOnly = true
            } else {
              throw firstErr
            }
          }
        } catch (aiErr) {
          clearInterval(stageEmitter)
          const aiMsg = aiErr instanceof Error ? aiErr.message : String(aiErr)
          console.error('[intake:ai-error]', { file_id: fileId, error: aiMsg })

          const isPasswordProtected = /encrypted|password|locked|security/i.test(aiMsg)
          const isTooLarge = /request_too_large|too large|prompt is too long|too long/i.test(aiMsg)
          const isPageLimit = /page.*100|100.*page/i.test(aiMsg)
          const isRateLimit = /rate.?limit|429|overloaded|529/i.test(aiMsg)

          if (isPasswordProtected) {
            await failWith('PASSWORD_PROTECTED_PDF', aiMsg)
          } else if (isTooLarge || isPageLimit) {
            // Use a more specific message but still AI_EXTRACTION_FAILED stage
            emit('error', {
              message: isPageLimit
                ? 'The PDFs exceed the 100-page AI limit — upload the key plan sheets only.'
                : 'The plans are too large for AI analysis — try uploading fewer or smaller PDFs.',
              stage: 'AI_EXTRACTION_FAILED' satisfies FailureStage,
            })
            if (supabase) {
              await supabase.from('files').update({
                intake_status: 'failed',
                failure_stage: 'AI_EXTRACTION_FAILED',
                failure_reason: aiMsg.slice(0, 500),
                processing_time_ms: Date.now() - pipelineStart,
              }).eq('id', fileId)
            }
            controller.close()
          } else if (isRateLimit) {
            emit('error', { message: 'The AI service is busy right now — please try again in a minute.', stage: 'AI_EXTRACTION_FAILED' satisfies FailureStage })
            if (supabase) {
              await supabase.from('files').update({
                intake_status: 'failed',
                failure_stage: 'AI_EXTRACTION_FAILED',
                failure_reason: `Rate limit: ${aiMsg.slice(0, 400)}`,
                processing_time_ms: Date.now() - pipelineStart,
              }).eq('id', fileId)
            }
            controller.close()
          } else {
            await failWith('AI_EXTRACTION_FAILED', aiMsg)
          }
          return
        } finally {
          clearInterval(stageEmitter)
        }

        // Track response length as proxy for extracted text volume
        extractedTextLength = anthropicResponse?.length ?? 0
        console.log('[intake:extracted]', { file_id: fileId, extracted_text_length: extractedTextLength })

        for (let i = stageIdx; i < stageIndices.length; i++) {
          emit('progress', PROGRESS_STAGES[stageIndices[i]])
        }

        // ── Step 5: Scope intelligence ────────────────────────────────────
        emit('progress', PROGRESS_STAGES[9]) // scope_intelligence

        let scopeHints: ScopeHint[] = []
        try {
          const scopeRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/estimation/scope-hints`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ project_metadata: projectMetadata }),
          })
          if (scopeRes.ok) {
            const scopeData = await scopeRes.json()
            scopeHints = scopeData.scope_hints ?? []
          }
        } catch {
          // Non-fatal
        }

        // ── Step 6: Parse & validate line items (with retry + OCR fallback) ───
        emit('progress', PROGRESS_STAGES[10]) // validating

        const diag: ExtractionDiag = {
          file_id: fileId,
          doc_blocks_sent: allDocBlocks.length,
          primary_response_length: anthropicResponse?.length ?? 0,
          primary_response_sample: anthropicResponse?.slice(0, 500) ?? '',
          primary_parse: 'json_failed',
          primary_parse_error: null,
          primary_truncated: false,
          primary_had_fence: false,
          retry_attempted: false,
          final_line_items: 0,
          used_prefill: usedPrefill,
          model: 'claude-sonnet-4-6',
          timestamp: new Date().toISOString(),
        }

        console.log('[intake:response]', {
          file_id: fileId,
          doc_blocks: diag.doc_blocks_sent,
          response_length: diag.primary_response_length,
          response_sample: anthropicResponse?.slice(0, 300),
          used_prefill: usedPrefill,
        })

        let lineItems: Array<{
          trade_category_id: number
          description: string
          quantity: number | null
          unit: string | null
          dimensions_string: string | null
          confidence: number
          subcategory_code: string | null
          pricing_type?: 'measured' | 'pc_allowance' | 'provisional_sum'
          source_ref?: string | null
          labour_cost?: number | null
          material_cost?: number | null
          subcontract_cost?: number | null
          plant_cost?: number | null
        }> = []
        let confidenceSummary = ''
        let isManualReviewMode = false

        // Attempt 1
        const attempt1 = tryExtractJson(anthropicResponse)
        diag.primary_parse_error = attempt1.error
        diag.primary_truncated = attempt1.truncated
        diag.primary_had_fence = attempt1.had_fence
        if (attempt1.data) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          lineItems = attempt1.data.line_items as any[]
          confidenceSummary = attempt1.data.confidence_summary
          diag.primary_parse = lineItems.length > 0 ? 'success' : 'empty_array'
        }

        console.log('[intake:parse]', {
          file_id: fileId,
          attempt: 1,
          result: diag.primary_parse,
          error: diag.primary_parse_error,
          truncated: diag.primary_truncated,
          had_fence: diag.primary_had_fence,
          line_items: lineItems.length,
        })

        // Attempt 2 — triggered when JSON failed or line_items is empty.
        if (diag.primary_parse !== 'success') {
          const isRefusal = /\b(cannot|unable|sorry|don.t see|no text|blank|unreadable|unclear|scanned image|image.only|no content|not possible)\b/i
            .test(anthropicResponse?.slice(0, 600) ?? '')
          const isTruncated = diag.primary_truncated

          const retryReason = isTruncated
            ? 'truncated_output'
            : diag.primary_parse === 'json_failed'
              ? (isRefusal ? 'refusal_detected' : 'json_parse_failed')
              : 'empty_line_items'

          diag.retry_attempted = true
          diag.retry_reason = retryReason

          console.warn('[intake:retry]', {
            file_id: fileId,
            reason: retryReason,
            primary_length: diag.primary_response_length,
            primary_error: diag.primary_parse_error,
            primary_sample: anthropicResponse?.slice(0, 400),
          })

          try {
            const retryBlocks = droppedToPrimaryOnly ? [docBlock] : allDocBlocks

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            let retryMessages: any[]

            if (isTruncated) {
              // Response was cut off — ask for a compact version with no whitespace
              retryMessages = [{
                role: 'user',
                content: [
                  ...retryBlocks,
                  { type: 'text', text: extractionPrompt + '\n\nCRITICAL: Your previous response was truncated. Produce a COMPACT response with no extra whitespace so it fits within the token limit. Output ONLY the JSON object starting with { and ending with }.' },
                ],
              }]
            } else if (isRefusal || diag.primary_parse === 'empty_array') {
              // Scanned/image doc or empty result — instruct QS estimates
              retryMessages = [{
                role: 'user',
                content: [
                  ...retryBlocks,
                  { type: 'text', text: extractionPrompt + '\n\nThis document may be image-based or drawing-heavy. As a senior QS with 20 years experience, produce professional estimates from what you can observe. You MUST produce line items — set confidence to 30–55 for estimated items so the builder can review them. Output ONLY valid JSON starting with {.' },
                ],
              }]
            } else {
              // JSON formatting failure — multi-turn repair with explicit fix instruction
              retryMessages = [
                { role: 'user', content: [...retryBlocks, { type: 'text', text: extractionPrompt }] },
                { role: 'assistant', content: anthropicResponse ?? '' },
                { role: 'user', content: 'Your response could not be parsed as JSON. Fix the formatting only — do not change any data values. Output ONLY the corrected JSON object. Start with { and end with }. No backticks, no explanation.' },
              ]
            }

            // Use prefill on fresh requests (not multi-turn repair)
            const retryUsesPrefill = retryMessages.length === 1
            if (retryUsesPrefill) {
              retryMessages.push({ role: 'assistant', content: EXTRACTION_PREFILL })
            }

            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const retryResp = await (client.messages.create as any)({
              model: 'claude-sonnet-4-6',
              max_tokens: 8192,
              messages: retryMessages,
            })
            const retryCompletion: string = retryResp.content[0]?.type === 'text' ? retryResp.content[0].text : ''
            const retryText = retryUsesPrefill ? EXTRACTION_PREFILL + retryCompletion : retryCompletion
            diag.retry_response_length = retryText.length

            const attempt2 = tryExtractJson(retryText)
            diag.retry_parse_error = attempt2.error
            diag.retry_truncated = attempt2.truncated

            console.log('[intake:retry-result]', {
              file_id: fileId,
              error: attempt2.error,
              truncated: attempt2.truncated,
              had_fence: attempt2.had_fence,
              line_items: attempt2.data?.line_items.length ?? 0,
              sample: retryText.slice(0, 300),
            })

            if (attempt2.data && attempt2.data.line_items.length > 0) {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              lineItems = attempt2.data.line_items as any[]
              confidenceSummary = attempt2.data.confidence_summary
              diag.retry_parse = 'success'
              console.log('[intake:retry-success]', { file_id: fileId, line_items: lineItems.length })
            } else {
              diag.retry_parse = attempt2.data ? 'empty_array' : 'json_failed'
              console.warn('[intake:retry-failed]', { file_id: fileId, retry_result: diag.retry_parse, retry_error: attempt2.error })
            }
          } catch (retryErr) {
            diag.retry_parse = 'json_failed'
            diag.retry_parse_error = retryErr instanceof Error ? retryErr.message : String(retryErr)
            console.error('[intake:retry-error]', { file_id: fileId, error: diag.retry_parse_error })
          }
        }

        diag.final_line_items = lineItems.length
        console.log('[intake:diag]', JSON.stringify(diag))

        // ── Route to correct failure stage or degrade gracefully ──────────────
        if (lineItems.length === 0) {
          const bothAttemptsFailed = !diag.retry_attempted
            ? diag.primary_parse === 'json_failed'
            : diag.primary_parse === 'json_failed' && diag.retry_parse === 'json_failed'

          const responseIsVeryShort = extractedTextLength < 200
          const responseIsScanned = /scanned|image.only|no text|cannot read/i.test(diag.primary_response_sample)

          if (bothAttemptsFailed) {
            // Determine the most specific failure stage
            if (extractedTextLength === 0) {
              await failWith('AI_NO_OUTPUT', `Model returned empty text, response_len=${extractedTextLength}`, { line_item_count: 0 })
            } else if (diag.primary_truncated || diag.retry_truncated) {
              await failWith('AI_TRUNCATED_OUTPUT', `Response truncated, primary_len=${diag.primary_response_length}, retry_len=${diag.retry_response_length ?? 0}`, { line_item_count: 0 })
            } else if (responseIsVeryShort || responseIsScanned) {
              await failWith('NO_TEXT_EXTRACTED', `Response too short or indicated scanned doc (${extractedTextLength} chars)`, { line_item_count: 0 })
            } else {
              await failWith('AI_INVALID_JSON', `primary_error=${diag.primary_parse_error}, retry_error=${diag.retry_parse_error ?? 'none'}, response_len=${extractedTextLength}`, { line_item_count: 0 })
            }
            return
          }

          // JSON parsed successfully but line_items was empty on both attempts.
          // Degrade gracefully: create a 0-item draft quote for manual completion
          // rather than hard-failing the entire intake.
          isManualReviewMode = true
          console.warn('[intake:manual-review]', {
            file_id: fileId,
            reason: 'both_attempts_empty_line_items',
            primary_parse: diag.primary_parse,
            retry_parse: diag.retry_parse,
          })
        }

        const assumptions: Array<{ description: string; gate: number; message: string }> = []

        const validatedItems = lineItems.map((item) => {
          let isAssumption = false
          let assumptionMessage: string | null = null
          let assumptionStatus: 'unresolved' | 'excluded' = 'unresolved'

          const isAllowance = item.pricing_type === 'pc_allowance' || item.pricing_type === 'provisional_sum'

          if (!item.unit && !isAllowance) {
            isAssumption = true
            assumptionMessage = `Quantity unit not specified — confirm unit for ${item.description}`
            assumptions.push({ description: item.description, gate: 1, message: assumptionMessage })
          } else if (item.quantity !== null && !item.dimensions_string && !isAllowance) {
            isAssumption = true
            assumptionMessage = `Quantity unverified from plans — confirm ${item.quantity} ${item.unit} for ${item.description}`
            assumptions.push({ description: item.description, gate: 2, message: assumptionMessage })
          } else if (item.quantity !== null && item.quantity <= 0) {
            isAssumption = true
            assumptionStatus = 'excluded'
            assumptionMessage = `Invalid quantity (${item.quantity}) for ${item.description} — excluded`
            assumptions.push({ description: item.description, gate: 3, message: assumptionMessage })
          }

          return { ...item, is_assumption: isAssumption, assumption_status: isAssumption ? assumptionStatus : null }
        })

        // ── Step 7: Create quote ──────────────────────────────────────────
        emit('progress', PROGRESS_STAGES[11]) // building_quote

        const explainability = buildExplainability(lineItems, similarProjects, projectMetadata)
        void confidenceSummary // used for future explainability enrichment

        // ── Step 7: Persist to DB if Supabase available, otherwise use memory ──
        let quoteId = `quote-${fileId.slice(0, 8)}`

        if (supabase) {
          try {
            const { data: quoteRow, error: quoteErr } = await supabase
              .from('quotes')
              .insert({
                job_id,
                builder_id,
                status: 'draft',
                total_cost: null,
                margin_pct: null,
                confidence_score: null,
                version: 1,
              })
              .select()
              .single()

            if (!quoteErr && quoteRow) {
              quoteId = quoteRow.id

              if (validatedItems.length > 0) {
                const lineItemInserts = validatedItems
                  .filter(item => item.assumption_status !== 'excluded')
                  .map(item => ({
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
                    pricing_type: item.pricing_type ?? 'measured',
                    source_ref: item.source_ref ?? null,
                    margin_pct: item.pricing_type === 'provisional_sum' ? 0 : 0.15,
                    labour_cost: item.labour_cost ?? null,
                    material_cost: item.material_cost ?? null,
                    subcontract_cost: item.subcontract_cost ?? null,
                    plant_cost: item.plant_cost ?? null,
                  }))

                const { data: insertedItems } = await supabase
                  .from('quote_line_items')
                  .insert(lineItemInserts)
                  .select()

                if (insertedItems && assumptions.length > 0) {
                  const assumptionInserts = assumptions.map(a => {
                    const matchingItem = insertedItems.find((li: { description: string }) => li.description === a.description)
                    return {
                      quote_id: quoteRow.id,
                      line_item_id: matchingItem?.id ?? null,
                      description: a.message,
                      resolution_type: null,
                      resolved_at: null,
                      resolved_by: null,
                    }
                  })
                  const { error: assumptionsErr } = await supabase.from('assumptions').insert(assumptionInserts)
                  if (assumptionsErr) console.error('[intake] assumptions insert:', assumptionsErr.message)
                }
              }

              const { error: memErr } = await supabase.from('project_memory').upsert({
                job_id, builder_id, quote_id: quoteRow.id, status: 'draft', ...projectMetadata,
              }, { onConflict: 'job_id' })
              if (memErr) console.error('[intake] project_memory upsert:', memErr.message)

              const { error: quoteMetaErr } = await supabase.from('quotes')
                .update({ metadata: { explainability, similar_project_count: similarProjects.length, extraction_diagnostics: diag } })
                .eq('id', quoteRow.id)
              if (quoteMetaErr) console.error('[intake] quote metadata update:', quoteMetaErr.message)

              const { error: extractedErr } = await supabase.from('files')
                .update({
                  intake_status: 'extracted',
                  quote_id: quoteRow.id,
                  line_item_count: lineItems.length,
                  extracted_text_length: extractedTextLength || null,
                  processing_time_ms: Date.now() - pipelineStart,
                  failure_stage: null,
                  failure_reason: null,
                })
                .eq('id', fileId)
              if (extractedErr) console.error('[intake] status→extracted:', extractedErr.message)
            }
          } catch {
            // Non-fatal — quote ID already set to memory-based ID
          }
        }

        const unresolvedCount = assumptions.filter(a => a.gate !== 3).length

        const sizeNote = droppedToPrimaryOnly
          ? ' Note: the full document set exceeded AI limits, so the estimate is based on the primary document only.'
          : skippedSiblingCount > 0
            ? ` Note: ${skippedSiblingCount} file${skippedSiblingCount !== 1 ? 's were' : ' was'} too large to include in the AI analysis.`
            : ''

        const completionMessage = isManualReviewMode
          ? `Draft quote created — no line items were detected automatically. Open the quote to add items manually.${sizeNote}`
          : `Draft quote ready — ${unresolvedCount} assumption${unresolvedCount !== 1 ? 's' : ''} need your review.${sizeNote}`

        const completeData: CompleteEvent = {
          stage: 'complete',
          message: completionMessage,
          pct: 100,
          quote_id: quoteId,
          assumption_count: unresolvedCount,
          similar_projects: similarProjects,
          scope_hints: scopeHints,
          total_in_memory: totalInMemory,
        }
        emit('complete', completeData)
        controller.close()
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err)
        console.error('[intake:unhandled]', { file_id: fileId, error: errMsg, stack: err instanceof Error ? err.stack?.slice(0, 600) : undefined })
        // Best-effort: write a failure record — supabase may be null if error occurred very early
        try {
          if (supabase) {
            await supabase.from('files').update({
              intake_status: 'failed',
              failure_stage: 'AI_EXTRACTION_FAILED',
              failure_reason: `Unhandled pipeline error: ${errMsg.slice(0, 400)}`,
              processing_time_ms: Date.now() - pipelineStart,
            }).eq('id', fileId)
          }
        } catch { /* ignore secondary failure */ }
        emit('error', { message: 'Processing failed — please try again', stage: 'AI_EXTRACTION_FAILED' })
        controller.close()
      }
    },
  })

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}
