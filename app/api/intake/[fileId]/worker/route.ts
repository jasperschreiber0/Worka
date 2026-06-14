import { NextRequest, NextResponse } from 'next/server'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// ─── Types ────────────────────────────────────────────────────────────────────

type FailureStage =
  | 'FILE_DOWNLOAD_FAILED'
  | 'DOCUMENT_TOO_SMALL'
  | 'AI_EXTRACTION_FAILED'
  | 'NO_LINE_ITEMS_FOUND'
  | 'NON_BUILDING_DOC'
  | 'PASSWORD_PROTECTED_PDF'

// ─── Tool schema ───────────────────────────────────────────────────────────────

const EXTRACT_TOOL_SCHEMA = {
  type: 'object' as const,
  properties: {
    doc_type: {
      type: 'string',
      enum: ['CONSTRUCTION_READY', 'SCHEMATIC_ONLY', 'MIXED_CONTENT', 'NON_BUILDING_DOC', 'LOW_QUALITY_SCAN'],
    },
    project: {
      type: 'object',
      properties: {
        job_type: {
          type: 'string',
          enum: ['rear_extension', 'side_extension', 'bathroom_reno', 'kitchen_reno', 'double_storey', 'granny_flat', 'new_build', 'knockdown_rebuild', 'full_renovation', 'deck_pergola', 'other'],
        },
        project_summary:    { type: 'string' },
        floor_area_m2:      { type: ['number', 'null'] },
        storeys:            { type: ['integer', 'null'] },
        wet_areas:          { type: ['integer', 'null'] },
        bedrooms:           { type: ['integer', 'null'] },
        finish_level:       { type: 'string', enum: ['budget', 'standard', 'premium', 'luxury'] },
        construction_type:  { type: 'string', enum: ['timber_frame', 'steel_frame', 'double_brick', 'brick_veneer', 'other'] },
        region:             { type: ['string', 'null'], enum: ['NSW', 'VIC', 'QLD', 'SA', 'WA', 'TAS', 'ACT', 'NT', null] },
        suburb:             { type: ['string', 'null'] },
      },
      required: ['job_type', 'project_summary', 'finish_level', 'construction_type'],
    },
    line_items: {
      type: 'array',
      minItems: 1,
      description: 'REQUIRED — must contain at least 5 items. If the document is schematic-only or unclear, produce professional QS estimates and set confidence to 30–45.',
      items: {
        type: 'object',
        properties: {
          trade_category_id:  { type: 'integer', minimum: 1, maximum: 13 },
          description:        { type: 'string' },
          quantity:           { type: ['number', 'null'] },
          unit:               { type: ['string', 'null'] },
          dimensions_string:  { type: ['string', 'null'] },
          confidence:         { type: 'integer', minimum: 0, maximum: 100 },
          pricing_type:       { type: 'string', enum: ['measured', 'pc_allowance', 'provisional_sum'] },
          source_ref:         { type: ['string', 'null'] },
          labour_cost:        { type: ['number', 'null'] },
          material_cost:      { type: ['number', 'null'] },
          subcontract_cost:   { type: ['number', 'null'] },
          plant_cost:         { type: ['number', 'null'] },
        },
        required: ['trade_category_id', 'description', 'confidence', 'pricing_type'],
      },
    },
    missing_categories: { type: 'array', items: { type: 'string' } },
    confidence_summary:  { type: 'string' },
  },
  required: ['doc_type', 'project', 'line_items', 'missing_categories', 'confidence_summary'],
}

const TRADE_CATEGORIES = [
  { id: 1,  name: 'Earthworks & Site Prep',    examples: 'excavation, site toilet, skip bins, scaffolding, fencing, surveying' },
  { id: 2,  name: 'Concrete',                  examples: 'slabs, footings, piers, formwork, reinforcement, concrete pump' },
  { id: 3,  name: 'Framing & Structural',      examples: 'timber wall frames, roof trusses, steel beams, LVL, structural posts' },
  { id: 4,  name: 'Roofing',                   examples: 'roof sheets, tiles, gutters, downpipes, fascia, sarking, ridge caps' },
  { id: 5,  name: 'Windows & External Doors',  examples: 'windows, sliding doors, entry doors, skylights, garage doors' },
  { id: 6,  name: 'External Cladding',         examples: 'FC cladding, weatherboard, render, brick, cavity battens, building wraps' },
  { id: 7,  name: 'Insulation',                examples: 'wall batts, ceiling batts, underfloor insulation' },
  { id: 8,  name: 'Internal Linings',          examples: 'plasterboard, cornice, set, internal doors, skirting, architraves' },
  { id: 9,  name: 'Joinery & Cabinetry',       examples: 'kitchen, bathroom vanities, laundry, wardrobes, benchtops' },
  { id: 10, name: 'Painting',                  examples: 'internal painting, external painting, primer, sealer, undercoat' },
  { id: 11, name: 'Plumbing',                  examples: 'rough-in, fixtures, hot water unit, drainage, stormwater, irrigation' },
  { id: 12, name: 'Electrical',                examples: 'power points, lights, switchboard, rough-in, data, smoke alarms' },
  { id: 13, name: 'Tiling & Finishes',         examples: 'floor tiles, wall tiles, waterproofing, carpet, vinyl, floor coverings' },
]

// ─── POST /api/intake/[fileId]/worker ─────────────────────────────────────────

export async function POST(
  req: NextRequest,
  { params }: { params: { fileId: string } }
): Promise<NextResponse> {
  // 1. Auth
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

  // 3. Supabase setup
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!supabaseUrl || !supabaseKey) {
    return NextResponse.json({ error: 'Supabase not configured' }, { status: 500 })
  }
  const { createClient } = await import('@supabase/supabase-js')
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const supabase: any = createClient(supabaseUrl, supabaseKey)

  // 4. Idempotency claim — 10s cap
  const pipelineStart = Date.now()
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const claimResult: any = await Promise.race([
    supabase.from('files')
      .update({ intake_status: 'processing', pipeline_stage: 'reading' })
      .eq('id', fileId)
      .in('intake_status', ['uploaded', 'queued'])
      .select().single(),
    new Promise((resolve) =>
      setTimeout(() => resolve({ data: null, error: new Error('claim timeout') }), 10_000)
    ),
  ])
  console.log('[intake:worker:claim]', { file_id: fileId, claimed: !!claimResult?.data })
  if (!claimResult?.data) return NextResponse.json({ ok: true, skipped: true })

  const w = (step: string) =>
    console.log('[W]', step, { file_id: fileId, elapsed_ms: Date.now() - pipelineStart })

  // Non-blocking stage update — resolves after 8s so slow Supabase never stalls the pipeline
  const updateStage = (stage: string): Promise<void> =>
    Promise.race([
      supabase.from('files').update({ pipeline_stage: stage }).eq('id', fileId).then(() => undefined),
      new Promise<void>((resolve) => setTimeout(resolve, 8_000)),
    ])

  const failWith = async (stage: FailureStage, reason: string) => {
    console.error('[intake:worker:fail]', { file_id: fileId, stage, reason })
    await Promise.race([
      supabase.from('files').update({
        intake_status: 'failed',
        failure_stage: stage,
        failure_reason: reason.slice(0, 500),
        processing_time_ms: Date.now() - pipelineStart,
        pipeline_stage: stage,
      }).eq('id', fileId),
      new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
    ])
  }

  const anthropicKey = process.env.ANTHROPIC_API_KEY
  if (!anthropicKey) {
    await failWith('AI_EXTRACTION_FAILED', 'ANTHROPIC_API_KEY not configured')
    return NextResponse.json({ ok: false, error: 'ANTHROPIC_API_KEY not configured' }, { status: 500 })
  }

  try {
    const Anthropic = (await import('@anthropic-ai/sdk')).default
    const client = new Anthropic({ apiKey: anthropicKey })

    // ── Load primary file ──────────────────────────────────────────────────
    w('updateStage:reading'); await updateStage('reading')

    const { getCachedFile } = await import('@/lib/file-cache')
    const cached = getCachedFile(fileId)

    let base64Data: string
    let primaryMediaType: string

    if (cached) {
      base64Data = cached.base64
      primaryMediaType = cached.mediaType
    } else {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const fileRecordResult: any = await Promise.race([
        supabase.from('files').select('*').eq('id', fileId).eq('builder_id', builder_id).single(),
        new Promise((resolve) => setTimeout(() => resolve({ data: null, error: new Error('timeout') }), 8_000)),
      ])
      const fileRow = fileRecordResult?.data
      if (!fileRow) {
        await failWith('FILE_DOWNLOAD_FAILED', 'File record not found — upload may not have completed')
        return NextResponse.json({ ok: false })
      }

      w('storage:download')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const downloadResult: any = await Promise.race([
        supabase.storage.from('plans').download(fileRow.storage_path),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Storage download timed out after 60s')), 60_000)
        ),
      ])
      const { data: fileData, error: downloadErr } = downloadResult as { data: Blob | null; error: { message: string } | null }
      if (downloadErr || !fileData) {
        await failWith('FILE_DOWNLOAD_FAILED', `Storage: ${(downloadErr as { message?: string } | null)?.message ?? 'unknown'}`)
        return NextResponse.json({ ok: false })
      }
      base64Data = Buffer.from(await fileData.arrayBuffer()).toString('base64')
      primaryMediaType = fileRow.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg'
    }

    const rawBytes = Math.ceil(base64Data.length * 0.75)
    const isCsv = primaryMediaType?.includes('csv') || primaryMediaType?.includes('text/plain')
    const isPdf = primaryMediaType?.includes('pdf')

    console.log('[intake:worker:file]', { file_id: fileId, raw_bytes: rawBytes, is_pdf: isPdf, is_csv: isCsv })

    if (!isCsv && rawBytes < 8192) {
      await failWith('DOCUMENT_TOO_SMALL', `File is ${rawBytes} bytes — too small for a building plan`)
      return NextResponse.json({ ok: false })
    }

    // Build primary doc block
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let docBlock: any
    if (isCsv) {
      const csvText = Buffer.from(base64Data, 'base64').toString('utf-8')
      docBlock = { type: 'text', text: `CSV FILE CONTENTS:\n\`\`\`\n${csvText.slice(0, 60000)}\n\`\`\`` }
    } else if (isPdf) {
      docBlock = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64Data } }
    } else {
      docBlock = { type: 'image', source: { type: 'base64', media_type: primaryMediaType ?? 'image/jpeg', data: base64Data } }
    }

    // ── Load sibling files ─────────────────────────────────────────────────
    const MAX_TOTAL_BYTES = 20 * 1024 * 1024
    let attachedBytes = rawBytes
    const siblingFileIds: string[] = Array.isArray(sibling_file_ids) ? sibling_file_ids : []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const siblingBlocks: any[] = []
    let skippedSiblingCount = 0

    for (const sibId of siblingFileIds.slice(0, 6)) {
      try {
        const sibCached = getCachedFile(sibId)
        if (sibCached) {
          const sibBytes = Math.ceil(sibCached.base64.length * 0.75)
          if (attachedBytes + sibBytes > MAX_TOTAL_BYTES) { skippedSiblingCount++; continue }
          attachedBytes += sibBytes
          const sibIsPdf = sibCached.mediaType.includes('pdf')
          const sibIsCsv = sibCached.mediaType.includes('csv') || sibCached.mediaType.includes('text/plain')
          if (sibIsCsv) {
            const sibText = Buffer.from(sibCached.base64, 'base64').toString('utf-8')
            siblingBlocks.push({ type: 'text', text: `CSV FILE (${sibCached.filename ?? 'file'}):\n\`\`\`\n${sibText.slice(0, 30000)}\n\`\`\`` })
          } else {
            siblingBlocks.push(sibIsPdf
              ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: sibCached.base64 } }
              : { type: 'image', source: { type: 'base64', media_type: sibCached.mediaType, data: sibCached.base64 } }
            )
          }
          continue
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sibRowResult: any = await Promise.race([
          supabase.from('files').select('*').eq('id', sibId).eq('builder_id', builder_id).single(),
          new Promise((resolve) => setTimeout(() => resolve({ data: null }), 8_000)),
        ])
        const sibRow = sibRowResult?.data
        if (!sibRow) continue
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const sibDl: any = await Promise.race([
          supabase.storage.from('plans').download(sibRow.storage_path),
          new Promise((resolve) => setTimeout(() => resolve({ data: null }), 30_000)),
        ])
        if (!sibDl?.data) { skippedSiblingCount++; continue }
        const sibBuf = await sibDl.data.arrayBuffer()
        if (attachedBytes + sibBuf.byteLength > MAX_TOTAL_BYTES) { skippedSiblingCount++; continue }
        attachedBytes += sibBuf.byteLength
        const sibBase64 = Buffer.from(sibBuf).toString('base64')
        siblingBlocks.push(sibRow.file_type === 'pdf'
          ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: sibBase64 } }
          : { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: sibBase64 } }
        )
      } catch { /* skip unreadable sibling */ }
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const allDocBlocks: any[] = [docBlock, ...siblingBlocks]

    // ── Retrieve memory context (non-blocking) ────────────────────────────
    w('updateStage:retrieving_memory'); await updateStage('retrieving_memory')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let similarProjects: any[] = []
    let totalInMemory = 0
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let builderProfile: any = null
    let memoryContextBlock = ''

    try {
      w('db:project_memory')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const memResult: any = await Promise.race([
        supabase.from('project_memory').select('*').eq('builder_id', builder_id)
          .in('status', ['completed', 'active']).order('completed_at', { ascending: false }).limit(20),
        new Promise((resolve) => setTimeout(() => resolve({ data: null }), 10_000)),
      ])
      const memRows = memResult?.data ?? []
      totalInMemory = memRows.length
      similarProjects = memRows.slice(0, 5)
      if (memRows.length > 0) {
        memoryContextBlock = `\n\nHISTORICAL CONTEXT — ${memRows.length} past project${memRows.length !== 1 ? 's' : ''} in memory:\n` +
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          memRows.slice(0, 5).map((p: any) =>
            `• ${p.project_summary ?? p.job_type ?? 'Project'} (${p.floor_area_m2 ?? '?'}sqm, ${p.region ?? '?'}, quoted ${p.quoted_cost ? `$${p.quoted_cost.toLocaleString()}` : 'unknown'})`
          ).join('\n')
      }
    } catch { /* non-fatal */ }

    try {
      w('db:builder_profile')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const profileResult: any = await Promise.race([
        supabase.from('builder_estimation_profiles').select('*').eq('builder_id', builder_id).single(),
        new Promise((resolve) => setTimeout(() => resolve({ data: null, error: null }), 10_000)),
      ])
      builderProfile = profileResult?.data ?? null
    } catch { /* non-fatal */ }

    const profileContext = builderProfile
      ? `\n\nBUILDER PROFILE: ${builderProfile.finish_level ?? 'standard'} finish, ${builderProfile.typical_margin_pct ?? 15}% typical margin, ${builderProfile.region ?? 'AU'}`
      : ''

    // ── Single Claude extraction call with tool use ────────────────────────
    // All documents go in one context window. Tool use guarantees schema-valid
    // output — no JSON parsing, no sanitization passes, no retry for format errors.
    w('updateStage:extracting_site'); await updateStage('extracting_site')

    const docCount = allDocBlocks.length
    const systemPrompt = `You are a senior quantity surveyor with 20 years of Australian residential construction experience. You are reviewing ${docCount > 1 ? `${docCount} documents` : 'a document'} for an Australian residential construction project.

Your task: produce a COMPLETE construction cost takeoff. You MUST always produce line items — an empty response is never acceptable.

CRITICAL RULES:
1. ALWAYS produce at least 5–10 line_items. Never return an empty array.
2. If the document contains a quantity schedule, extract every line item with a quantity and rate.
3. If the document is schematic plans only (floor plans, elevations), produce professional QS estimates from visible dimensions and layout. A senior QS estimates even from floor plans — this is your core skill.
4. If you cannot read the document clearly, produce conservative professional estimates for a typical residential project of this type. Set confidence to 25–40 for anything estimated without clear data.
5. Descriptions must be specific: "Concrete slab — 125mm ground floor" not "Concrete".
6. Use Australian units: m², lm, m, m³, ea, hr, wk. Never sf or LF.
7. Set pricing_type: measured (extracted from schedule/dimensions), pc_allowance (prime cost), or provisional_sum (TBD by others).${memoryContextBlock}${profileContext}`

    const userText = `Extract a complete quantity takeoff from the provided construction document${docCount > 1 ? 's' : ''}.

Trade categories (include items from ALL relevant categories):
${TRADE_CATEGORIES.map(c => `${c.id}. ${c.name} — ${c.examples}`).join('\n')}

Remember: you MUST return at least 5 line_items. If the document is unclear, estimate professionally — never return empty line_items.

Use the extract_estimate tool to return your results.`

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let extractResult: any = null
    let droppedToPrimaryOnly = false

    const runExtraction = async (
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      blocks: any[],
      timeoutMs: number
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ): Promise<any> => {
      // AbortController actually closes the HTTP socket when the timer fires.
      // Promise.race alone doesn't cancel the in-flight request, leaving the
      // connection open and keeping the Vercel function alive past our timeout.
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), timeoutMs)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response: any = await (client.messages.create as any)(
          {
            model: 'claude-sonnet-4-6',
            max_tokens: 8192,
            system: systemPrompt,
            tools: [{ name: 'extract_estimate', description: 'Return the complete quantity takeoff and project assessment', input_schema: EXTRACT_TOOL_SCHEMA }],
            tool_choice: { type: 'tool', name: 'extract_estimate' },
            messages: [{ role: 'user', content: [...blocks, { type: 'text', text: userText }] }],
          },
          { signal: controller.signal }
        )
        console.log('[intake:worker:ai]', {
          file_id: fileId,
          doc_blocks: blocks.length,
          input_tokens: response.usage?.input_tokens,
          output_tokens: response.usage?.output_tokens,
        })
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return response.content?.find((b: any) => b.type === 'tool_use' && b.name === 'extract_estimate')?.input ?? null
      } finally {
        clearTimeout(timer)
      }
    }

    try {
      w('ai:extract:start')
      extractResult = await runExtraction(allDocBlocks, 180_000)
      w('ai:extract:done')
    } catch (firstErr) {
      const firstMsg = firstErr instanceof Error ? firstErr.message : String(firstErr)
      const isTooLarge = /request_too_large|too large|prompt is too long|page limit|100 pages|413/i.test(firstMsg)

      if (isTooLarge && allDocBlocks.length > 1) {
        console.warn('[intake:worker:too-large]', { file_id: fileId, retrying: 'primary_only' })
        try {
          w('ai:extract:retry')
          const remainingMs = 290_000 - (Date.now() - pipelineStart)
          extractResult = await runExtraction([docBlock], Math.min(remainingMs, 80_000))
          droppedToPrimaryOnly = true
          w('ai:extract:retry:done')
        } catch (retryErr) {
          await failWith('AI_EXTRACTION_FAILED', retryErr instanceof Error ? retryErr.message : String(retryErr))
          return NextResponse.json({ ok: false })
        }
      } else {
        const isPasswordProtected = /encrypted|password|locked|security/i.test(firstMsg)
        await failWith(isPasswordProtected ? 'PASSWORD_PROTECTED_PDF' : 'AI_EXTRACTION_FAILED', firstMsg)
        return NextResponse.json({ ok: false })
      }
    }

    if (!extractResult) {
      await failWith('AI_EXTRACTION_FAILED', 'No tool_use block in Claude response')
      return NextResponse.json({ ok: false })
    }

    if (extractResult.doc_type === 'NON_BUILDING_DOC') {
      await failWith('NON_BUILDING_DOC', 'Document classified as non-building document')
      return NextResponse.json({ ok: false })
    }

    // NOTE: extractResult may be replaced by the empty-retry block below — read these after
    let projectMetadata = extractResult.project ?? {}
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let rawLineItems: any[] = extractResult.line_items ?? []
    let missingCategories: string[] = extractResult.missing_categories ?? []

    console.log('[intake:worker:items]', {
      file_id: fileId,
      doc_type: extractResult.doc_type,
      line_items: rawLineItems.length,
      missing: missingCategories,
      summary: extractResult.confidence_summary,
    })

    if (rawLineItems.length === 0) {
      // Retry with an even more explicit prompt before giving up
      const elapsedMs = Date.now() - pipelineStart
      const retryBudget = 290_000 - elapsedMs
      if (retryBudget > 30_000) {
        console.warn('[intake:worker:retry-empty]', { file_id: fileId, doc_type: extractResult.doc_type, budget_ms: retryBudget })
        try {
          const retryBlocks = droppedToPrimaryOnly ? [docBlock] : allDocBlocks
          const retryText = userText + '\n\nIMPORTANT: Your previous attempt returned zero line items, which is not acceptable. Even if this document is schematic-only or image-based, you are a professional QS — produce your best professional estimates for a typical Australian residential build of this type. Include at minimum: site works, concrete/footings, framing, roofing, and fit-out items. Set confidence to 30–45 for estimated items. The builder needs a starting point, not an empty quote.'
          // Use runExtraction so the AbortController timeout applies — direct
          // client.messages.create calls have no timeout and will hang until Vercel kills at 300s.
          const retryController = new AbortController()
          const retryTimer = setTimeout(() => retryController.abort(), Math.min(retryBudget, 60_000))
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          let retryResponse: any
          try {
            retryResponse = await (client.messages.create as any)(
              {
                model: 'claude-sonnet-4-6',
                max_tokens: 8192,
                system: systemPrompt,
                tools: [{ name: 'extract_estimate', description: 'Return the complete quantity takeoff and project assessment', input_schema: EXTRACT_TOOL_SCHEMA }],
                tool_choice: { type: 'tool', name: 'extract_estimate' },
                messages: [{ role: 'user', content: [...retryBlocks, { type: 'text', text: retryText }] }],
              },
              { signal: retryController.signal }
            )
          } finally {
            clearTimeout(retryTimer)
          }
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const retryBlock = retryResponse?.content?.find((b: any) => b.type === 'tool_use' && b.name === 'extract_estimate')
          if (retryBlock?.input?.line_items?.length > 0) {
            extractResult = retryBlock.input
            rawLineItems = extractResult.line_items ?? []
            missingCategories = extractResult.missing_categories ?? []
            projectMetadata = extractResult.project ?? projectMetadata
            console.log('[intake:worker:retry-empty:success]', { file_id: fileId, items: rawLineItems.length })
          } else {
            await failWith('NO_LINE_ITEMS_FOUND', `Both attempts returned empty line_items. doc_type=${extractResult.doc_type}`)
            return NextResponse.json({ ok: false })
          }
        } catch (retryErr) {
          await failWith('NO_LINE_ITEMS_FOUND', `Retry failed: ${retryErr instanceof Error ? retryErr.message : String(retryErr)}`)
          return NextResponse.json({ ok: false })
        }
      } else {
        await failWith('NO_LINE_ITEMS_FOUND', `doc_type=${extractResult.doc_type}, summary=${extractResult.confidence_summary}`)
        return NextResponse.json({ ok: false })
      }
    }

    // ── Scope intelligence ─────────────────────────────────────────────────
    w('updateStage:scope_intelligence'); await updateStage('scope_intelligence')

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let scopeHints: any[] = []
    try {
      w('fetch:scope-hints')
      const scopeRes = await fetch(`${process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000'}/api/estimation/scope-hints`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${supabaseKey}` },
        body: JSON.stringify({ project_metadata: projectMetadata }),
      })
      if (scopeRes.ok) scopeHints = (await scopeRes.json()).scope_hints ?? []
    } catch { /* non-fatal */ }

    // ── Validation gates ──────────────────────────────────────────────────
    w('updateStage:validating'); await updateStage('validating')

    const assumptions: Array<{ description: string; gate: number; message: string }> = []

    const validatedItems = rawLineItems
      .filter((item) => item.trade_category_id >= 1 && item.trade_category_id <= 13)
      .map((item) => {
        const isAllowance = item.pricing_type === 'pc_allowance' || item.pricing_type === 'provisional_sum'
        let isAssumption = false
        let assumptionMessage: string | null = null
        let assumptionStatus: 'unresolved' | 'excluded' = 'unresolved'

        if (!item.unit && !isAllowance) {
          isAssumption = true
          assumptionMessage = `Quantity unit not specified — confirm unit for ${item.description}`
          assumptions.push({ description: item.description, gate: 1, message: assumptionMessage })
        } else if (item.quantity != null && !item.dimensions_string && !isAllowance) {
          isAssumption = true
          assumptionMessage = `Quantity unverified from plans — confirm ${item.quantity} ${item.unit} for ${item.description}`
          assumptions.push({ description: item.description, gate: 2, message: assumptionMessage })
        } else if (item.quantity != null && item.quantity <= 0) {
          isAssumption = true
          assumptionStatus = 'excluded'
          assumptionMessage = `Invalid quantity (${item.quantity}) for ${item.description} — excluded`
          assumptions.push({ description: item.description, gate: 3, message: assumptionMessage })
        }

        return { ...item, is_assumption: isAssumption, assumption_status: isAssumption ? assumptionStatus : null }
      })

    // ── DB writes — all guarded with 45s timeout ──────────────────────────
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const withDbTimeout = (promise: Promise<any>, label: string): Promise<any> =>
      Promise.race([
        promise,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`DB timeout: ${label}`)), 45_000)
        ),
      ])

    w('updateStage:building_quote'); await withDbTimeout(updateStage('building_quote'), 'updateStage')

    let quoteId = `quote-${fileId.slice(0, 8)}`

    try {
      w('db:quote:insert')
      const { data: quoteRow, error: quoteErr } = await withDbTimeout(
        supabase.from('quotes').insert({
          job_id, builder_id, status: 'draft',
          total_cost: null, margin_pct: null, confidence_score: null, version: 1,
        }).select().single(),
        'quotes.insert'
      )

      if (!quoteErr && quoteRow) {
        quoteId = quoteRow.id

        const lineItemInserts = validatedItems
          .filter(item => item.assumption_status !== 'excluded')
          .map(item => ({
            quote_id: quoteRow.id,
            trade_category_id: item.trade_category_id,
            description: item.description,
            quantity: item.quantity ?? null,
            unit: item.unit ?? null,
            rate: null,
            total: null,
            confidence: item.confidence ?? 50,
            dimensions_string: item.dimensions_string ?? null,
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

        if (lineItemInserts.length > 0) {
          w('db:line_items:insert')
          const { data: insertedItems } = await withDbTimeout(
            supabase.from('quote_line_items').insert(lineItemInserts).select(),
            'quote_line_items.insert'
          )

          if (insertedItems && assumptions.length > 0) {
            const assumptionInserts = assumptions.map(a => {
              // eslint-disable-next-line @typescript-eslint/no-explicit-any
              const match = insertedItems.find((li: any) => li.description === a.description)
              return {
                quote_id: quoteRow.id, line_item_id: match?.id ?? null,
                description: a.message, resolution_type: null, resolved_at: null, resolved_by: null,
              }
            })
            w('db:assumptions:insert')
            await withDbTimeout(
              supabase.from('assumptions').insert(assumptionInserts),
              'assumptions.insert'
            ).catch((e: Error) => console.error('[intake:worker] assumptions:', e.message))
          }
        }

        // Best-effort memory upsert
        withDbTimeout(
          supabase.from('project_memory').upsert(
            { job_id, builder_id, quote_id: quoteRow.id, status: 'draft', ...projectMetadata },
            { onConflict: 'job_id' }
          ),
          'project_memory.upsert'
        ).catch((e: Error) => console.error('[intake:worker] project_memory:', e.message))
      }
    } catch (dbErr) {
      console.error('[intake:worker:db-error]', { file_id: fileId, error: dbErr instanceof Error ? dbErr.message : String(dbErr) })
      // Non-fatal — quoteId stays as memory-based ID, SSE will still fire complete
    }

    // ── Write final status + complete payload ─────────────────────────────
    const unresolvedCount = assumptions.filter(a => a.gate !== 3).length
    const docTypeNote = droppedToPrimaryOnly ? ' (estimated from primary document only due to file size)' : ''
    const completionMessage =
      extractResult.doc_type === 'SCHEMATIC_ONLY'
        ? `Plans analysed — ${validatedItems.length} item${validatedItems.length !== 1 ? 's' : ''} estimated from floor plan. All items need your review.${docTypeNote}`
        : `Draft quote ready — ${unresolvedCount} assumption${unresolvedCount !== 1 ? 's' : ''} need your review.${docTypeNote}${skippedSiblingCount > 0 ? ` ${skippedSiblingCount} file${skippedSiblingCount !== 1 ? 's were' : ' was'} too large to include.` : ''}`

    const completeData = {
      stage: 'complete',
      message: completionMessage,
      pct: 100,
      quote_id: quoteId,
      assumption_count: unresolvedCount,
      similar_projects: similarProjects,
      scope_hints: scopeHints,
      total_in_memory: totalInMemory,
    }

    w('db:files:extracted')
    const { error: extractedErr } = await withDbTimeout(
      supabase.from('files').update({
        intake_status: 'extracted',
        quote_id: quoteId,
        line_item_count: validatedItems.length,
        processing_time_ms: Date.now() - pipelineStart,
        failure_stage: null,
        failure_reason: null,
      }).eq('id', fileId),
      'files.update(extracted)'
    )
    if (extractedErr) console.error('[intake:worker] status→extracted:', (extractedErr as { message?: string })?.message)

    // Best-effort: write pipeline_stage + intake_result (requires migration 016)
    withDbTimeout(
      supabase.from('files').update({
        pipeline_stage: 'complete',
        intake_result: completeData as unknown as Record<string, unknown>,
      }).eq('id', fileId),
      'files.update(pipeline_stage)'
    ).catch(() => { /* non-fatal */ })

    console.log('[intake:worker:done]', { file_id: fileId, quote_id: quoteId, total_ms: Date.now() - pipelineStart })
    return NextResponse.json({ ok: true })

  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err)
    console.error('[intake:worker:unhandled]', { file_id: fileId, error: errMsg, stack: err instanceof Error ? err.stack?.slice(0, 600) : undefined })
    try {
      await Promise.race([
        supabase.from('files').update({
          intake_status: 'failed',
          failure_stage: 'AI_EXTRACTION_FAILED',
          failure_reason: `Unhandled: ${errMsg.slice(0, 400)}`,
          processing_time_ms: Date.now() - pipelineStart,
          pipeline_stage: 'AI_EXTRACTION_FAILED',
        }).eq('id', fileId),
        new Promise<void>((resolve) => setTimeout(resolve, 10_000)),
      ])
    } catch { /* ignore */ }
    return NextResponse.json({ ok: false, error: errMsg }, { status: 500 })
  }
}
