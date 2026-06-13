import { NextRequest, NextResponse } from 'next/server'
import type { ProjectMetadata, SimilarProject, ScopeHint, BuilderEstimationProfile } from '@/lib/types/estimation.types'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ─── Types ────────────────────────────────────────────────────────────────────

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

// Document classification — determined from the expanded metadata call (Haiku)
type DocType =
  | 'CONSTRUCTION_READY'  // has schedules / quantity data → full extraction
  | 'SCHEMATIC_ONLY'      // floor plan only, no schedules → inferred items
  | 'MIXED_CONTENT'       // some structured items, some gaps → partial extraction
  | 'NON_BUILDING_DOC'    // not a building document at all → early stop
  | 'LOW_QUALITY_SCAN'    // can't be read reliably → OCR/estimate mode
  | 'UNKNOWN'             // classification failed → treat as MIXED_CONTENT

interface DocClassification {
  doc_type: DocType
  has_schedules: boolean
  has_dimensions: boolean
  visible_categories: string[]
  missing_categories_hint: string[]
}

interface ExtractionDiag {
  file_id: string
  doc_type: DocType
  has_schedules: boolean
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
  final_inferred_items: number
  missing_categories: string[]
  used_prefill: false
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
  | 'NON_BUILDING_DOC'

// ─── Progress stages ──────────────────────────────────────────────────────────

const PROGRESS_STAGES = [
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

// ─── Metadata + classification prompt ────────────────────────────────────────

const METADATA_PROMPT = `Analyse this building document and return ONLY a JSON object with two sections.

SECTION 1 — Project metadata:
- job_type: one of rear_extension, side_extension, bathroom_reno, kitchen_reno, double_storey, granny_flat, new_build, knockdown_rebuild, full_renovation, deck_pergola, other
- renovation_type: one of extension, renovation, new_build, addition, alteration, knockdown_rebuild
- project_summary: 1-2 sentence plain English description
- floor_area_m2: number or null
- storeys: integer or null
- wet_areas: integer or null
- bedrooms: integer or null
- finish_level: one of budget, standard, premium, luxury
- construction_type: one of timber_frame, steel_frame, double_brick, brick_veneer, other
- region: one of NSW, VIC, QLD, SA, WA, TAS, ACT, NT — or null
- suburb: suburb name if visible or null

SECTION 2 — Document classification:
- doc_type: classify the document as exactly one of:
  CONSTRUCTION_READY (contains quantity schedules, specifications, or annotated dimensions ready for quoting)
  SCHEMATIC_ONLY (floor plans / elevations only, no schedules or quantities)
  MIXED_CONTENT (some scheduled/quantified items plus schematic pages)
  NON_BUILDING_DOC (not a construction document — e.g. invoice, photo, text document)
  LOW_QUALITY_SCAN (building document but too blurry or low-resolution to read reliably)
  UNKNOWN (cannot determine)
- has_schedules: true if the document contains door/window/finish schedules or quantity lists
- has_dimensions: true if plans show measured dimensions (e.g. 3600, 4200)
- visible_categories: array of trade category names that appear to have content (e.g. ["Concrete","Framing","Roofing"])
- missing_categories_hint: array of trade categories that seem absent but would be expected for this project type

Return ONLY this JSON structure:
{"job_type":"other","renovation_type":"renovation","project_summary":"description","floor_area_m2":null,"storeys":null,"wet_areas":null,"bedrooms":null,"finish_level":"standard","construction_type":"timber_frame","region":null,"suburb":null,"doc_type":"CONSTRUCTION_READY","has_schedules":false,"has_dimensions":true,"visible_categories":[],"missing_categories_hint":[]}`

// ─── Quantity extraction prompt (memory-enhanced) ─────────────────────────────

function buildExtractionPrompt(
  similarProjects: SimilarProject[],
  builderProfile: BuilderEstimationProfile | null,
  projectSummary: string,
  documentCount = 1,
  docClassification: DocClassification | null = null
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

  // Mode-specific instruction block based on what the document contains
  const docType = docClassification?.doc_type ?? 'UNKNOWN'
  const isSchematicOnly = docType === 'SCHEMATIC_ONLY'
  const missingHint = (docClassification?.missing_categories_hint ?? []).length > 0
    ? `\nCategories likely missing from these plans: ${docClassification!.missing_categories_hint.join(', ')}.`
    : ''

  const modeInstructions = isSchematicOnly
    ? `DOCUMENT TYPE: Schematic / floor plan only — no quantity schedules found.
Your task: produce inferred professional estimates from layout and dimensions visible in the plans.
- Set ALL confidence values between 25–55 (these are estimates, not measured quantities)
- Put all items in "inferred_items" (not "line_items") so the builder knows they need verification
- Include at minimum: slab/footing, framing, roofing, windows, painting, and any wet areas visible
- Use dimensions visible in plans to estimate areas; show working in dimensions_string${missingHint}`
    : `DOCUMENT TYPE: ${docType === 'CONSTRUCTION_READY' ? 'Quantity-ready — extract measured items directly' : 'Mixed content — extract measured items where available, infer the rest'}.
Your task: produce a complete construction cost takeoff.
- Put items extracted from schedules/dimensions in "line_items" (confidence 70–100)
- Put items you must professionally estimate in "inferred_items" (confidence 25–69)
- List trade categories with no evidence at all in "missing_categories"${missingHint}`

  return `You are a senior quantity surveyor with 20 years of Australian residential construction experience. You ALWAYS produce output — you never return empty arrays.

PROJECT:
${projectSummary}
${historicalContext}
${profileContext}

${docNote}

${modeInstructions}

Instructions:
1. Read ALL provided documents before extracting.
2. NEVER leave both line_items and inferred_items empty. If plans are unclear, make professional estimates and set confidence accordingly.
3. For each trade, produce multiple items. A bathroom reno needs separate items for waterproofing, tiling, vanity, toilet, shower screen, tapware, etc.
4. Use Australian terminology (m², lm, ea, m³ — never sf or LF; AUD amounts).
5. Show dimension calculations in dimensions_string where possible.
6. Every item in a schedule, legend, or specification must be captured.

For EVERY item (in both line_items and inferred_items) provide:
- trade_category_id (1–13)
- description (specific: "Concrete slab — ground floor 125mm" not "Concrete")
- quantity (number or null)
- unit (m², lm, ea, m³, hr — or null)
- dimensions_string ("14.2m × 8.6m = 122.1m²" or null)
- confidence (0–100)
- subcategory_code (e.g. "TILE-FLOOR", "FRAM-WALL")
- pricing_type ("measured", "pc_allowance", or "provisional_sum")
- source_ref (drawing reference or null)
- labour_cost (AUD or null)
- material_cost (AUD or null)
- subcontract_cost (AUD or null)
- plant_cost (AUD or null)

Trade categories:
${tradeCategories.map(c => `${c.id}. ${c.name}`).join('\n')}

${historicalContext ? 'IMPORTANT: Use the historical projects as your benchmark.' : ''}

STRICT OUTPUT RULE:
- Output ONLY the JSON object. No markdown. No backticks. No explanations.
- Start with { and end with }
- All strings use double quotes. Unknown values are null — never omit a key.
- pricing_type must be exactly: "measured", "pc_allowance", or "provisional_sum"
- Maximum 12 items per trade category. If a trade has more, keep the 12 highest-value items and discard the rest.
- Description strings must not contain newline characters — use a single line of text only.
- Do not repeat items that are functionally identical — merge them into one with a combined quantity.

Output this exact structure:
{"line_items":[{"trade_category_id":2,"description":"Concrete slab — ground floor 125mm","quantity":112.0,"unit":"m²","dimensions_string":"14.2m × 7.9m = 112.2m²","confidence":88,"subcategory_code":"CONC-SLAB","pricing_type":"measured","source_ref":"A1.0","labour_cost":5600,"material_cost":8400,"subcontract_cost":null,"plant_cost":800}],"inferred_items":[{"trade_category_id":4,"description":"Roof tiling — concrete tiles","quantity":130.0,"unit":"m²","dimensions_string":null,"confidence":42,"subcategory_code":"ROOF-TILE","pricing_type":"provisional_sum","source_ref":null,"labour_cost":null,"material_cost":null,"subcontract_cost":9500,"plant_cost":null}],"missing_categories":["Electrical","Plumbing"],"confidence_summary":"Moderate — slab and framing scaled from plans; roofing and fit-out are professional estimates"}`
}

// ─── JSON extraction helper ───────────────────────────────────────────────────

interface ParseResult {
  data: {
    line_items: unknown[]
    inferred_items: unknown[]
    missing_categories: string[]
    confidence_summary: string
  } | null
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

  // Strip markdown fences
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/)
  if (fence) { text = fence[1].trim(); had_fence = true }

  const start = text.indexOf('{')
  if (start < 0) return fail('no_opening_brace', false, had_fence)

  const end = text.lastIndexOf('}')
  if (end <= start) return fail('truncated_no_closing_brace', true, had_fence)

  text = text.slice(start, end + 1)

  // Strip trailing commas before ] or } — common LLM formatting mistake
  text = text.replace(/,(\s*[}\]])/g, '$1')

  const buildData = (parsed: Record<string, unknown>) => ({
    line_items: Array.isArray(parsed.line_items) ? parsed.line_items : [],
    inferred_items: Array.isArray(parsed.inferred_items) ? parsed.inferred_items : [],
    missing_categories: Array.isArray(parsed.missing_categories)
      ? parsed.missing_categories.filter((x: unknown) => typeof x === 'string')
      : [],
    confidence_summary: String(parsed.confidence_summary ?? ''),
  })

  // Pass 1: standard parse
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object') {
      return { data: buildData(parsed as Record<string, unknown>), error: null, truncated: false, had_fence }
    }
  } catch (e1) {
    const parseError = e1 instanceof Error ? e1.message : 'json_parse_error'
    console.warn('[intake:json-sanitize]', { pass: 1, error: parseError, text_length: text.length, sample_near_error: (() => {
      const m = parseError.match(/position (\d+)/)
      if (m) { const pos = parseInt(m[1]); return text.slice(Math.max(0, pos - 80), pos + 80) }
      return text.slice(-200)
    })() })
  }

  // Pass 2: replace literal newlines/CR/tabs with spaces
  try {
    const sanitized = text.replace(/\r\n/g, ' ').replace(/[\r\n\t]/g, ' ')
    const parsed = JSON.parse(sanitized)
    if (parsed && typeof parsed === 'object') {
      console.warn('[intake:json-sanitize]', { pass: 2, recovered: true })
      return { data: buildData(parsed as Record<string, unknown>), error: null, truncated: false, had_fence }
    }
  } catch { /* fall through to pass 3 */ }

  // Pass 3: strip all ASCII control characters except space, then try once more
  try {
    const sanitized = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '').replace(/[\r\n\t]/g, ' ')
    const parsed = JSON.parse(sanitized)
    if (parsed && typeof parsed === 'object') {
      console.warn('[intake:json-sanitize]', { pass: 3, recovered: true })
      return { data: buildData(parsed as Record<string, unknown>), error: null, truncated: false, had_fence }
    }
  } catch (e3) {
    return fail(e3 instanceof Error ? e3.message : 'json_parse_error', false, had_fence)
  }

  return fail('json_parse_error', false, had_fence)
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

// ─── POST /api/intake/[fileId]/worker ─────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { fileId: string } }
): Promise<NextResponse> {
  // 1. Auth: check Authorization header
  const authHeader = req.headers.get('authorization')
  if (authHeader !== `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`) {
    return NextResponse.json({ error: 'Forbidden' }, { status: 403 })
  }

  // 2. Parse body
  const { builder_id, job_id, sibling_file_ids } = await req.json() as {
    builder_id: string
    job_id: string
    sibling_file_ids: string[]
  }
  const fileId = params.fileId

  // 3. Set up Supabase
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }
  const { createClient } = await import('@supabase/supabase-js')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(supabaseUrl, supabaseKey)

  // 4. Idempotency check + atomic start
  const { data: claimedRow } = await supabase
    .from('files')
    .update({ intake_status: 'processing', pipeline_stage: 'reading' })
    .eq('id', fileId)
    .in('intake_status', ['uploaded', 'queued'])
    .select()
    .single()

  if (!claimedRow) {
    return NextResponse.json({ ok: true, skipped: true })
  }

  const pipelineStart = Date.now()

  // Helper: update pipeline_stage in DB for SSE monitor polling
  const updateStage = async (stage: string) => {
    await supabase.from('files').update({ pipeline_stage: stage }).eq('id', fileId)
  }

  // Helper: write failure record to DB (no SSE)
  const failWith = async (
    stage: FailureStage,
    internalReason: string,
    extra?: { line_item_count?: number; page_count?: number }
  ) => {
    const processingTimeMs = Date.now() - pipelineStart
    console.error('[intake:worker:fail]', {
      file_id: fileId,
      stage,
      reason: internalReason,
      processing_time_ms: processingTimeMs,
      ...extra,
    })
    await supabase.from('files').update({
      intake_status: 'failed',
      failure_stage: stage,
      failure_reason: internalReason.slice(0, 500),
      processing_time_ms: processingTimeMs,
      pipeline_stage: stage,
      ...(extra?.line_item_count != null && { line_item_count: extra.line_item_count }),
      ...(extra?.page_count != null && { page_count: extra.page_count }),
    }).eq('id', fileId)
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    await failWith('AI_EXTRACTION_FAILED', 'ANTHROPIC_API_KEY not configured')
    return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  // Metrics accumulated during the run
  let extractedTextLength = 0

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey: anthropicKey })

    // Fetch file record from DB
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let fileRow: any = null
    const { data, error: fileErr } = await supabase
      .from('files')
      .select('*')
      .eq('id', fileId)
      .eq('builder_id', builder_id)
      .single()
    if (!fileErr) fileRow = data

    await updateStage('reading')

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
        return NextResponse.json({ ok: false })
      }

      const { data: fileData, error: downloadErr } = await supabase.storage
        .from('plans')
        .download(fileRow.storage_path)

      if (downloadErr || !fileData) {
        const storageMsg = (downloadErr as { message?: string } | null)?.message ?? 'unknown'
        await failWith('FILE_DOWNLOAD_FAILED', `Storage download failed: ${storageMsg}`)
        return NextResponse.json({ ok: false })
      }

      const fileBuffer = await fileData.arrayBuffer()
      base64Data = Buffer.from(fileBuffer).toString('base64')
      primaryMediaType = fileRow?.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg'
    }

    await updateStage('analysing')

    const detectedMediaType = cached?.mediaType ?? primaryMediaType ?? ''
    const isPdf = detectedMediaType.includes('pdf') || fileRow?.file_type === 'pdf'
    const isCsv = detectedMediaType.includes('csv') || detectedMediaType.includes('text/plain')
      || fileRow?.filename?.toLowerCase().endsWith('.csv')
    const mediaType = isPdf ? 'application/pdf' : 'image/jpeg'

    // Reject files that are clearly too small to contain a building plan.
    const rawBytes = Math.ceil(base64Data.length * 0.75)
    console.log('[intake:worker:file]', { file_id: fileId, media_type: detectedMediaType, raw_bytes: rawBytes, is_pdf: isPdf, is_csv: isCsv })
    if (!isCsv && rawBytes < 8192) {
      await failWith('DOCUMENT_TOO_SMALL', `File is only ${rawBytes} bytes — too small for a building plan`)
      return NextResponse.json({ ok: false })
    }

    // CSV: decode as UTF-8 text and inject as a text block
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let docBlock: any
    if (isCsv) {
      const csvText = Buffer.from(base64Data, 'base64').toString('utf-8')
      extractedTextLength = csvText.length
      console.log('[intake:worker:csv]', { file_id: fileId, text_length: extractedTextLength })
      docBlock = { type: 'text', text: `CSV FILE CONTENTS:\n\`\`\`\n${csvText.slice(0, 60000)}\n\`\`\`` }
    } else if (isPdf) {
      docBlock = { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Data } }
    } else {
      docBlock = { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } }
    }

    // Load sibling files
    const MAX_TOTAL_RAW_BYTES = 20 * 1024 * 1024
    let attachedRawBytes = Math.ceil(base64Data.length * 0.75)
    let skippedSiblingCount = 0
    const siblingFileIds: string[] = Array.isArray(sibling_file_ids) ? sibling_file_ids : []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const siblingBlocks: any[] = []
    for (const sibId of siblingFileIds.slice(0, 6)) {
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

    // ── Step 1: Extract project metadata + classify document ─────────────
    let projectMetadata: ProjectMetadata = {
      job_type: null, renovation_type: null, project_summary: 'Residential construction project',
      floor_area_m2: null, storeys: null, wet_areas: null, bedrooms: null,
      finish_level: null, construction_type: null, region: null, suburb: null,
    }

    let docClassification: DocClassification = {
      doc_type: 'UNKNOWN',
      has_schedules: false,
      has_dimensions: false,
      visible_categories: [],
      missing_categories_hint: [],
    }

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const metaResponse = await (client.messages.create as any)({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 768,
        messages: [{ role: 'user', content: [docBlock, { type: 'text', text: METADATA_PROMPT }] }],
      })
      const metaText = metaResponse.content[0]?.type === 'text' ? metaResponse.content[0].text : ''
      const metaMatch = metaText.match(/\{[\s\S]*\}/)
      if (metaMatch) {
        const cleaned = metaMatch[0].replace(/,(\s*[}\]])/g, '$1')
        const parsed = JSON.parse(cleaned)
        projectMetadata = { ...projectMetadata, ...parsed }
        docClassification = {
          doc_type: (parsed.doc_type as DocType) ?? 'UNKNOWN',
          has_schedules: Boolean(parsed.has_schedules),
          has_dimensions: Boolean(parsed.has_dimensions),
          visible_categories: Array.isArray(parsed.visible_categories) ? parsed.visible_categories : [],
          missing_categories_hint: Array.isArray(parsed.missing_categories_hint) ? parsed.missing_categories_hint : [],
        }
      }
    } catch {
      // Non-fatal — continue with defaults
    }

    console.log('[intake:worker:classify]', {
      file_id: fileId,
      doc_type: docClassification.doc_type,
      has_schedules: docClassification.has_schedules,
      has_dimensions: docClassification.has_dimensions,
      visible_categories: docClassification.visible_categories,
      missing_categories_hint: docClassification.missing_categories_hint,
    })

    // Early exit for documents that are clearly not building docs
    if (docClassification.doc_type === 'NON_BUILDING_DOC') {
      await failWith('NON_BUILDING_DOC', `Document classified as NON_BUILDING_DOC by Haiku`)
      return NextResponse.json({ ok: false })
    }

    // ── Step 2: Retrieve similar historical projects ───────────────────
    await updateStage('retrieving_memory')

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
    const extractionPrompt = buildExtractionPrompt(similarProjects, builderProfile, projectMetadata.project_summary, allDocBlocks.length, docClassification)

    // Cycle through extraction stages while Claude processes
    const stageNames = ['extracting_site', 'extracting_framing', 'extracting_roofing', 'extracting_fitout', 'extracting_elec']
    let stageIdx = 0
    const stageEmitter = setInterval(async () => {
      if (stageIdx < stageNames.length) {
        await updateStage(stageNames[stageIdx])
        stageIdx++
      }
    }, 2000)

    let anthropicResponse = ''
    let droppedToPrimaryOnly = false

    console.log('[intake:worker:ai-prompt]', {
      file_id: fileId,
      doc_blocks: allDocBlocks.length,
      prompt_length: extractionPrompt.length,
      model: 'claude-sonnet-4-6',
      max_tokens: 8192,
    })

    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const callExtraction = async (blocks: any[]): Promise<string> => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const messages: any[] = [{ role: 'user', content: [...blocks, { type: 'text', text: extractionPrompt }] }]
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response = await (client.messages.create as any)({
          model: 'claude-sonnet-4-6',
          max_tokens: 8192,
          messages,
        })
        const text: string = response.content[0]?.type === 'text' ? response.content[0].text : ''
        console.log('[intake:worker:ai-response]', {
          file_id: fileId,
          input_tokens: response.usage?.input_tokens ?? null,
          output_tokens: response.usage?.output_tokens ?? null,
          response_length: text.length,
          response_sample: text.slice(0, 200),
        })
        return text
      }

      try {
        anthropicResponse = await callExtraction(allDocBlocks)
      } catch (firstErr) {
        const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
        const isTooLarge = /request_too_large|too large|prompt is too long|too long|page limit|100 pages|413/i.test(firstMsg)
        if (isTooLarge && allDocBlocks.length > 1) {
          console.warn('[intake:worker:ai-fallback]', { file_id: fileId, reason: 'too_large', retrying_with: 'primary_only', error: firstMsg })
          anthropicResponse = await callExtraction([docBlock])
          droppedToPrimaryOnly = true
        } else {
          throw firstErr
        }
      }
    } catch (aiErr) {
      clearInterval(stageEmitter)
      const aiMsg = aiErr instanceof Error ? aiErr.message : String(aiErr)
      console.error('[intake:worker:ai-error]', { file_id: fileId, error: aiMsg })

      const isPasswordProtected = /encrypted|password|locked|security/i.test(aiMsg)
      const isTooLarge = /request_too_large|too large|prompt is too long|too long/i.test(aiMsg)
      const isPageLimit = /page.*100|100.*page/i.test(aiMsg)
      const isRateLimit = /rate.?limit|429|overloaded|529/i.test(aiMsg)

      if (isPasswordProtected) {
        await failWith('PASSWORD_PROTECTED_PDF', aiMsg)
      } else if (isTooLarge || isPageLimit) {
        await supabase.from('files').update({
          intake_status: 'failed',
          failure_stage: 'AI_EXTRACTION_FAILED',
          failure_reason: aiMsg.slice(0, 500),
          processing_time_ms: Date.now() - pipelineStart,
          pipeline_stage: 'AI_EXTRACTION_FAILED',
        }).eq('id', fileId)
      } else if (isRateLimit) {
        await supabase.from('files').update({
          intake_status: 'failed',
          failure_stage: 'AI_EXTRACTION_FAILED',
          failure_reason: `Rate limit: ${aiMsg.slice(0, 400)}`,
          processing_time_ms: Date.now() - pipelineStart,
          pipeline_stage: 'AI_EXTRACTION_FAILED',
        }).eq('id', fileId)
      } else {
        await failWith('AI_EXTRACTION_FAILED', aiMsg)
      }
      return NextResponse.json({ ok: false })
    } finally {
      clearInterval(stageEmitter)
    }

    // Track response length as proxy for extracted text volume
    extractedTextLength = anthropicResponse?.length ?? 0
    console.log('[intake:worker:extracted]', { file_id: fileId, extracted_text_length: extractedTextLength })

    // ── Step 5: Scope intelligence ────────────────────────────────────
    await updateStage('scope_intelligence')

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
    await updateStage('validating')

    const diag: ExtractionDiag = {
      file_id: fileId,
      doc_type: docClassification.doc_type,
      has_schedules: docClassification.has_schedules,
      doc_blocks_sent: allDocBlocks.length,
      primary_response_length: anthropicResponse?.length ?? 0,
      primary_response_sample: anthropicResponse?.slice(0, 500) ?? '',
      primary_parse: 'json_failed',
      primary_parse_error: null,
      primary_truncated: false,
      primary_had_fence: false,
      retry_attempted: false,
      final_line_items: 0,
      final_inferred_items: 0,
      missing_categories: [],
      used_prefill: false,
      model: 'claude-sonnet-4-6',
      timestamp: new Date().toISOString(),
    }

    console.log('[intake:worker:response]', {
      file_id: fileId,
      doc_blocks: diag.doc_blocks_sent,
      response_length: diag.primary_response_length,
      response_sample: anthropicResponse?.slice(0, 300),
    })

    type LineItemRaw = {
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
    }

    let lineItems: LineItemRaw[] = []
    let inferredItems: LineItemRaw[] = []
    let missingCategories: string[] = []
    let confidenceSummary = ''
    let isManualReviewMode = false

    const applyParseResult = (data: ParseResult['data']) => {
      if (!data) return
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      lineItems = data.line_items as any[]
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inferredItems = data.inferred_items as any[]
      missingCategories = data.missing_categories
      confidenceSummary = data.confidence_summary
    }

    // Attempt 1
    const attempt1 = tryExtractJson(anthropicResponse)
    diag.primary_parse_error = attempt1.error
    diag.primary_truncated = attempt1.truncated
    diag.primary_had_fence = attempt1.had_fence
    if (attempt1.data) {
      applyParseResult(attempt1.data)
      diag.primary_parse = (lineItems.length + inferredItems.length) > 0 ? 'success' : 'empty_array'
    }

    console.log('[intake:worker:parse]', {
      file_id: fileId,
      attempt: 1,
      result: diag.primary_parse,
      error: diag.primary_parse_error,
      truncated: diag.primary_truncated,
      had_fence: diag.primary_had_fence,
      line_items: lineItems.length,
      inferred_items: inferredItems.length,
      missing_categories: missingCategories,
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

      console.warn('[intake:worker:retry]', {
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
          retryMessages = [{
            role: 'user',
            content: [
              ...retryBlocks,
              { type: 'text', text: extractionPrompt + '\n\nCRITICAL: Your previous response was truncated. Produce a COMPACT response with no extra whitespace so it fits within the token limit. Output ONLY the JSON object starting with { and ending with }.' },
            ],
          }]
        } else if (isRefusal || diag.primary_parse === 'empty_array') {
          retryMessages = [{
            role: 'user',
            content: [
              ...retryBlocks,
              { type: 'text', text: extractionPrompt + '\n\nThis document may be image-based or drawing-heavy. As a senior QS with 20 years experience, produce professional estimates from what you can observe. You MUST produce line items — set confidence to 30–55 for estimated items so the builder can review them. Output ONLY valid JSON starting with {.' },
            ],
          }]
        } else {
          retryMessages = [{
            role: 'user',
            content: [
              ...retryBlocks,
              { type: 'text', text: extractionPrompt + '\n\nPREVIOUS ATTEMPT FAILED JSON VALIDATION. Re-extract with these ADDITIONAL constraints:\n- Maximum 8 items per trade category (keep highest-value only)\n- No newline characters anywhere in string values\n- Compact JSON (no extra whitespace)\n- Output ONLY valid JSON starting with { and ending with }' },
            ],
          }]
        }

        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const retryResp = await (client.messages.create as any)({
          model: 'claude-sonnet-4-6',
          max_tokens: 8192,
          messages: retryMessages,
        })
        const retryText: string = retryResp.content[0]?.type === 'text' ? retryResp.content[0].text : ''
        diag.retry_response_length = retryText.length

        const attempt2 = tryExtractJson(retryText)
        diag.retry_parse_error = attempt2.error
        diag.retry_truncated = attempt2.truncated

        console.log('[intake:worker:retry-result]', {
          file_id: fileId,
          error: attempt2.error,
          truncated: attempt2.truncated,
          had_fence: attempt2.had_fence,
          line_items: attempt2.data?.line_items.length ?? 0,
          sample: retryText.slice(0, 300),
        })

        if (attempt2.data && (attempt2.data.line_items.length > 0 || attempt2.data.inferred_items.length > 0)) {
          applyParseResult(attempt2.data)
          diag.retry_parse = 'success'
          console.log('[intake:worker:retry-success]', { file_id: fileId, line_items: lineItems.length, inferred_items: inferredItems.length })
        } else {
          diag.retry_parse = attempt2.data ? 'empty_array' : 'json_failed'
          console.warn('[intake:worker:retry-failed]', { file_id: fileId, retry_result: diag.retry_parse, retry_error: attempt2.error })
        }
      } catch (retryErr) {
        diag.retry_parse = 'json_failed'
        diag.retry_parse_error = retryErr instanceof Error ? retryErr.message : String(retryErr)
        console.error('[intake:worker:retry-error]', { file_id: fileId, error: diag.retry_parse_error })
      }
    }

    diag.final_line_items = lineItems.length
    diag.final_inferred_items = inferredItems.length
    diag.missing_categories = missingCategories
    console.log('[intake:worker:diag]', JSON.stringify(diag))

    // ── Route to correct failure stage or degrade gracefully ──────────────
    const totalItems = lineItems.length + inferredItems.length
    if (totalItems === 0) {
      const bothAttemptsFailed = !diag.retry_attempted
        ? diag.primary_parse === 'json_failed'
        : diag.primary_parse === 'json_failed' && diag.retry_parse === 'json_failed'

      const responseIsVeryShort = extractedTextLength < 200
      const responseIsScanned = /scanned|image.only|no text|cannot read/i.test(diag.primary_response_sample)

      if (bothAttemptsFailed) {
        if (extractedTextLength === 0) {
          await failWith('AI_NO_OUTPUT', `Model returned empty text, response_len=${extractedTextLength}`, { line_item_count: 0 })
        } else if (diag.primary_truncated || diag.retry_truncated) {
          await failWith('AI_TRUNCATED_OUTPUT', `Response truncated, primary_len=${diag.primary_response_length}, retry_len=${diag.retry_response_length ?? 0}`, { line_item_count: 0 })
        } else if (responseIsVeryShort || responseIsScanned) {
          await failWith('NO_TEXT_EXTRACTED', `Response too short or indicated scanned doc (${extractedTextLength} chars)`, { line_item_count: 0 })
        } else {
          await failWith('AI_INVALID_JSON', `primary_error=${diag.primary_parse_error}, retry_error=${diag.retry_parse_error ?? 'none'}, response_len=${extractedTextLength}`, { line_item_count: 0 })
        }
        return NextResponse.json({ ok: false })
      }

      // JSON parsed successfully but line_items was empty on both attempts.
      // Degrade gracefully: create a 0-item draft quote for manual completion.
      isManualReviewMode = true
      console.warn('[intake:worker:manual-review]', {
        file_id: fileId,
        reason: 'both_attempts_empty_line_items',
        doc_type: docClassification.doc_type,
        primary_parse: diag.primary_parse,
        retry_parse: diag.retry_parse,
      })
    }

    // Inferred items always become assumptions (low confidence, builder must verify)
    const allLineItems = [
      ...lineItems,
      ...inferredItems.map(item => ({ ...item, _inferred: true })),
    ]

    const assumptions: Array<{ description: string; gate: number; message: string }> = []

    const validatedItems = allLineItems.map((item) => {
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
    await updateStage('building_quote')

    const explainability = buildExplainability(allLineItems, similarProjects, projectMetadata)
    void confidenceSummary

    let quoteId = `quote-${fileId.slice(0, 8)}`

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
            if (assumptionsErr) console.error('[intake:worker] assumptions insert:', assumptionsErr.message)
          }
        }

        const { error: memErr } = await supabase.from('project_memory').upsert({
          job_id, builder_id, quote_id: quoteRow.id, status: 'draft', ...projectMetadata,
        }, { onConflict: 'job_id' })
        if (memErr) console.error('[intake:worker] project_memory upsert:', memErr.message)

        const { error: quoteMetaErr } = await supabase.from('quotes')
          .update({ metadata: { explainability, similar_project_count: similarProjects.length, extraction_diagnostics: diag } })
          .eq('id', quoteRow.id)
        if (quoteMetaErr) console.error('[intake:worker] quote metadata update:', quoteMetaErr.message)
      }
    } catch {
      // Non-fatal — quoteId stays as memory-based ID
    }

    const unresolvedCount = assumptions.filter(a => a.gate !== 3).length

    const sizeNote = droppedToPrimaryOnly
      ? ' Note: the full document set exceeded AI limits, so the estimate is based on the primary document only.'
      : skippedSiblingCount > 0
        ? ` Note: ${skippedSiblingCount} file${skippedSiblingCount !== 1 ? 's were' : ' was'} too large to include in the AI analysis.`
        : ''

    // Build a doc-type-aware completion message
    let completionMessage: string
    if (isManualReviewMode) {
      completionMessage = `Draft quote created — no items were detected automatically. Open the quote to add items manually.${sizeNote}`
    } else if (docClassification.doc_type === 'SCHEMATIC_ONLY') {
      completionMessage = `We found plans but no measurable schedules — ${inferredItems.length} item${inferredItems.length !== 1 ? 's' : ''} inferred from the floor plan layout. All items need your review before quoting.${sizeNote}`
    } else if (docClassification.doc_type === 'MIXED_CONTENT' && inferredItems.length > 0) {
      const measuredNote = lineItems.length > 0 ? `${lineItems.length} measured` : ''
      const inferredNote = `${inferredItems.length} inferred`
      completionMessage = `Partial extraction complete — ${[measuredNote, inferredNote].filter(Boolean).join(', ')} item${allLineItems.length !== 1 ? 's' : ''}. ${unresolvedCount} assumption${unresolvedCount !== 1 ? 's' : ''} need your review.${sizeNote}`
    } else {
      completionMessage = `Draft quote ready — ${unresolvedCount} assumption${unresolvedCount !== 1 ? 's' : ''} need your review.${sizeNote}`
    }

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

    // Write final success record to DB — SSE monitor polls for intake_status='extracted'
    const { error: extractedErr } = await supabase.from('files').update({
      intake_status: 'extracted',
      quote_id: quoteId,
      line_item_count: allLineItems.length,
      extracted_text_length: extractedTextLength || null,
      processing_time_ms: Date.now() - pipelineStart,
      failure_stage: null,
      failure_reason: null,
      pipeline_stage: 'complete',
      intake_result: completeData as unknown as Record<string, unknown>,
    }).eq('id', fileId)
    if (extractedErr) console.error('[intake:worker] status→extracted:', extractedErr.message)

    return NextResponse.json({ ok: true })
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('[intake:worker:unhandled]', { file_id: fileId, error: errMsg, stack: err instanceof Error ? err.stack?.slice(0, 600) : undefined })
    try {
      await supabase.from('files').update({
        intake_status: 'failed',
        failure_stage: 'AI_EXTRACTION_FAILED',
        failure_reason: `Unhandled pipeline error: ${errMsg.slice(0, 400)}`,
        processing_time_ms: Date.now() - pipelineStart,
        pipeline_stage: 'AI_EXTRACTION_FAILED',
      }).eq('id', fileId)
    } catch { /* ignore secondary failure */ }
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 })
  }
}

