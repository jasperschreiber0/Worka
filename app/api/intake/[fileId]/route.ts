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

Return ONLY valid JSON:
{
  "line_items": [
    {
      "trade_category_id": number,
      "description": string,
      "quantity": number | null,
      "unit": string | null,
      "dimensions_string": string | null,
      "confidence": number,
      "subcategory_code": string | null,
      "pricing_type": "measured" | "pc_allowance" | "provisional_sum",
      "source_ref": string | null,
      "labour_cost": number | null,
      "material_cost": number | null,
      "subcontract_cost": number | null,
      "plant_cost": number | null
    }
  ],
  "confidence_summary": "1 sentence overall confidence assessment"
}`
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
      const emit = (event: string, data: object) => {
        controller.enqueue(sseEvent(encoder, event, data))
      }

      try {
        emit('progress', PROGRESS_STAGES[0]) // uploading

        const Anthropic = (await import('@anthropic-ai/sdk')).default
        const client = new Anthropic({ apiKey: anthropicKey })

        // Supabase is optional — memory cache is the primary file source
        const hasSupabase = Boolean(supabaseUrl && supabaseKey)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let supabase: any = null
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
            emit('error', { message: 'File record not found — the upload may not have completed. Please try uploading again.' })
            controller.close()
            return
          }

          const { data: fileData, error: downloadErr } = await supabase.storage
            .from('plans')
            .download(fileRow.storage_path)

          if (downloadErr || !fileData) {
            const storageMsg = (downloadErr as { message?: string } | null)?.message ?? 'unknown'
            emit('error', { message: `File not found in storage (${storageMsg}). Make sure the Supabase "plans" bucket exists and the file uploaded successfully.` })
            const { error: failedErr1 } = await supabase.from('files').update({ intake_status: 'failed' }).eq('id', fileId)
            if (failedErr1) console.error('[intake] status→failed (download):', failedErr1.message)
            controller.close()
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

        // CSV: decode as UTF-8 text and inject as a text block
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let docBlock: any
        if (isCsv) {
          const csvText = Buffer.from(base64Data, 'base64').toString('utf-8')
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

        let anthropicResponse: string
        let droppedToPrimaryOnly = false
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const callExtraction = async (blocks: any[]): Promise<string> => {
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            const response = await (client.messages.create as any)({
              model: 'claude-sonnet-4-6',
              max_tokens: 8192,
              messages: [{ role: 'user', content: [...blocks, { type: 'text', text: extractionPrompt }] }],
            })
            return response.content[0]?.type === 'text' ? response.content[0].text : ''
          }

          try {
            anthropicResponse = await callExtraction(allDocBlocks)
          } catch (firstErr) {
            const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
            const isTooLarge = /request_too_large|too large|prompt is too long|too long|page limit|100 pages|413/i.test(firstMsg)
            if (isTooLarge && allDocBlocks.length > 1) {
              // Combined documents exceed AI limits — retry with the primary
              // document only rather than failing the whole intake.
              console.warn('[intake] Full document set too large, retrying with primary only:', firstMsg)
              anthropicResponse = await callExtraction([docBlock])
              droppedToPrimaryOnly = true
            } else {
              throw firstErr
            }
          }
        } catch (aiErr) {
          clearInterval(stageEmitter)
          const aiMsg = aiErr instanceof Error ? aiErr.message : String(aiErr)
          console.error('[intake] Anthropic extraction error:', aiMsg)
          const friendly =
            /request_too_large|too large|prompt is too long|too long/i.test(aiMsg)
              ? 'The plans are too large for AI analysis — try uploading fewer or smaller PDFs (key plan sheets only).'
              : /page/i.test(aiMsg) && /100/.test(aiMsg)
                ? 'The PDFs exceed the 100-page AI limit — upload the key plan sheets only.'
                : /rate.?limit|429|overloaded|529/i.test(aiMsg)
                  ? 'The AI service is busy right now — please try again in a minute.'
                  : `AI extraction failed: ${aiMsg.slice(0, 180)}`
          emit('error', { message: friendly })
          if (supabase) {
            const { error: failedErr2 } = await supabase.from('files').update({ intake_status: 'failed' }).eq('id', fileId)
            if (failedErr2) console.error('[intake] status→failed (AI):', failedErr2.message)
          }
          controller.close()
          return
        } finally {
          clearInterval(stageEmitter)
        }

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

        // ── Step 6: Parse & validate line items ───────────────────────────
        emit('progress', PROGRESS_STAGES[10]) // validating

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

        try {
          let jsonText = anthropicResponse.trim()
          const fence = jsonText.match(/```(?:json)?\s*([\s\S]*?)```/)
          if (fence) jsonText = fence[1].trim()
          const start = jsonText.indexOf('{')
          const end = jsonText.lastIndexOf('}')
          if (start >= 0 && end > start) jsonText = jsonText.slice(start, end + 1)
          const parsed = JSON.parse(jsonText)
          lineItems = parsed.line_items ?? []
          confidenceSummary = parsed.confidence_summary ?? ''
        } catch {
          console.error('[intake] Malformed AI response:', anthropicResponse?.slice(0, 200))
          emit('error', { message: 'Could not extract line items from the plans — the PDF may be unclear or image-based.' })
          if (supabase) {
            const { error: failedErr3 } = await supabase.from('files').update({ intake_status: 'failed' }).eq('id', fileId)
            if (failedErr3) console.error('[intake] status→failed (parse):', failedErr3.message)
          }
          controller.close()
          return
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
                .update({ metadata: { explainability, similar_project_count: similarProjects.length } })
                .eq('id', quoteRow.id)
              if (quoteMetaErr) console.error('[intake] quote metadata update:', quoteMetaErr.message)

              const { error: extractedErr } = await supabase.from('files')
                .update({ intake_status: 'extracted', quote_id: quoteRow.id })
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

        const completeData: CompleteEvent = {
          stage: 'complete',
          message: `Draft quote ready — ${unresolvedCount} assumption${unresolvedCount !== 1 ? 's' : ''} need your review.${sizeNote}`,
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
        console.error('Intake pipeline error:', err)
        emit('error', { message: 'Processing failed — please try again' })
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
