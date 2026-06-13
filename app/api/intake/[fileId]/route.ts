import { NextRequest } from 'next/server'

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
}

// ─── Progress stages (demo pipeline) ─────────────────────────────────────────

const PROGRESS_STAGES: ProgressEvent[] = [
  { stage: 'uploading', message: 'Uploading plans...', pct: 5 },
  { stage: 'reading', message: 'Reading file...', pct: 15 },
  { stage: 'analysing', message: 'Analysing plans with AI...', pct: 30 },
  { stage: 'extracting_site', message: 'Extracting site works & concrete...', pct: 40 },
  { stage: 'extracting_framing', message: 'Extracting framing quantities...', pct: 50 },
  { stage: 'extracting_roofing', message: 'Extracting roofing...', pct: 58 },
  { stage: 'extracting_fitout', message: 'Extracting fit-out & finishes...', pct: 68 },
  { stage: 'extracting_electrical', message: 'Extracting electrical & prelims...', pct: 78 },
  { stage: 'validating', message: 'Running quantity validation gates...', pct: 88 },
  { stage: 'building_quote', message: 'Building draft quote...', pct: 95 },
]

// ─── SSE helpers ──────────────────────────────────────────────────────────────

function sseEvent(encoder: TextEncoder, event: string, data: object): Uint8Array {
  return encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── GET /api/intake/[fileId] ─────────────────────────────────────────────────

export async function GET(
  req: NextRequest,
  { params }: { params: { fileId: string } }
): Promise<Response> {
  const { fileId } = params
  const { searchParams } = new URL(req.url)
  const job_id = searchParams.get('job_id') ?? ''
  const builder_id =
    searchParams.get('builder_id') ?? '00000000-0000-0000-0000-000000000001'

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const isRealMode = Boolean(supabaseUrl && supabaseKey && anthropicKey)

  const encoder = new TextEncoder()

  // ── Demo mode ──────────────────────────────────────────────────────────────
  if (!isRealMode) {
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for (const stage of PROGRESS_STAGES) {
            await delay(600)
            controller.enqueue(sseEvent(encoder, 'progress', stage))
          }

          await delay(600)

          const completeData: CompleteEvent = {
            stage: 'complete',
            message: 'Draft quote ready — 3 assumptions need your review.',
            pct: 100,
            quote_id: 'demo-quote-id',
            assumption_count: 3,
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

  // ── Real mode: Supabase + Anthropic ───────────────────────────────────────
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: string, data: object) => {
        controller.enqueue(sseEvent(encoder, event, data))
      }

      try {
        // Stage: uploading
        emit('progress', PROGRESS_STAGES[0])

        const { createClient } = await import('@supabase/supabase-js')
        const supabase = createClient(supabaseUrl!, supabaseKey!)

        // Fetch file record
        const { data: fileRow, error: fileErr } = await supabase
          .from('files')
          .select('*')
          .eq('id', fileId)
          .single()

        if (fileErr || !fileRow) {
          emit('error', { message: 'File not found' })
          controller.close()
          return
        }

        // Update status to processing
        const { error: processingErr } = await supabase
          .from('files')
          .update({ intake_status: 'processing' })
          .eq('id', fileId)
        if (processingErr) {
          console.error('Failed to update file status to processing:', processingErr)
        }

        // Stage: reading
        emit('progress', PROGRESS_STAGES[1])

        // Download file from storage
        const { data: fileData, error: downloadErr } = await supabase.storage
          .from('plans')
          .download(fileRow.storage_path)

        if (downloadErr || !fileData) {
          emit('error', { message: 'Failed to read file from storage' })
          const { error: failedErr1 } = await supabase
            .from('files')
            .update({ intake_status: 'failed' })
            .eq('id', fileId)
          if (failedErr1) {
            console.error('Failed to update file status to failed (download):', failedErr1)
          }
          controller.close()
          return
        }

        // Stage: analysing
        emit('progress', PROGRESS_STAGES[2])

        // Convert to base64 for Anthropic API
        const fileBuffer = await fileData.arrayBuffer()
        const base64Data = Buffer.from(fileBuffer).toString('base64')
        const isPdf = fileRow.file_type === 'pdf'
        const mediaType = isPdf ? 'application/pdf' : 'image/jpeg'

        const Anthropic = (await import('@anthropic-ai/sdk')).default
        const client = new Anthropic({ apiKey: anthropicKey })

        // Trade categories aligned with CLAUDE.md
        const tradeCategories = [
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
${tradeCategories.map((c) => `${c.id}. ${c.name}`).join('\n')}

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

        // Emit extraction stages as we process
        const extractionStages = [3, 4, 5, 6, 7] // indices into PROGRESS_STAGES
        let stageIndex = 0

        // We emit each stage while Anthropic processes
        const stageEmitter = setInterval(() => {
          if (stageIndex < extractionStages.length) {
            emit('progress', PROGRESS_STAGES[extractionStages[stageIndex]])
            stageIndex++
          }
        }, 2000)

        let anthropicResponse: string
        try {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const messageContent: any[] = isPdf
            ? [
                {
                  type: 'document',
                  source: {
                    type: 'base64',
                    media_type: 'application/pdf',
                    data: base64Data,
                  },
                },
                { type: 'text', text: extractionPrompt },
              ]
            : [
                {
                  type: 'image',
                  source: {
                    type: 'base64',
                    media_type: 'image/jpeg',
                    data: base64Data,
                  },
                },
                { type: 'text', text: extractionPrompt },
              ]

          const response = await client.messages.create({
            model: 'claude-sonnet-4-20250514',
            max_tokens: 4096,
            // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
            messages: [{ role: 'user', content: messageContent }],
          })

          anthropicResponse =
            response.content[0].type === 'text' ? response.content[0].text : ''
        } finally {
          clearInterval(stageEmitter)
        }

        // Ensure all extraction stages emitted
        for (let i = stageIndex; i < extractionStages.length; i++) {
          emit('progress', PROGRESS_STAGES[extractionStages[i]])
        }

        // Stage: validating
        emit('progress', PROGRESS_STAGES[8])

        // Parse Anthropic response
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
          // Malformed JSON from AI — treat all as assumptions
          lineItems = []
        }

        // Apply the 3 quantity validation gates
        const assumptions: Array<{
          description: string
          gate: number
          message: string
        }> = []

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
          // Gate 2: No dimensions_string when quantity is present
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

        // Stage: building_quote
        emit('progress', PROGRESS_STAGES[9])

        // Create quote record
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

        if (quoteErr || !quoteRow) {
          emit('error', { message: 'Failed to create quote' })
          const { error: failedErr2 } = await supabase
            .from('files')
            .update({ intake_status: 'failed' })
            .eq('id', fileId)
          if (failedErr2) {
            console.error('Failed to update file status to failed (quote):', failedErr2)
          }
          controller.close()
          return
        }

        // Insert line items
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

          const { data: insertedItems, error: lineItemsErr } = await supabase
            .from('quote_line_items')
            .insert(lineItemInserts)
            .select()

          if (lineItemsErr) {
            console.error('Failed to insert line items:', lineItemsErr)
            emit('error', { message: 'Failed to save quote line items' })
            const { error: failedErr3 } = await supabase
              .from('files')
              .update({ intake_status: 'failed' })
              .eq('id', fileId)
            if (failedErr3) {
              console.error('Failed to update file status to failed (line items):', failedErr3)
            }
            controller.close()
            return
          }

          // Insert assumption records
          if (insertedItems && assumptions.length > 0) {
            const assumptionInserts = assumptions.map((a) => {
              const matchingItem = insertedItems.find((li) =>
                li.description === a.description
              )
              return {
                quote_id: quoteRow.id,
                line_item_id: matchingItem?.id ?? null,
                description: a.message,
                resolution_type: null,
                resolved_at: null,
                resolved_by: null,
              }
            })
            const { error: assumptionsErr } = await supabase
              .from('assumptions')
              .insert(assumptionInserts)
            if (assumptionsErr) {
              console.error('Failed to insert assumptions:', assumptionsErr)
            }
          }
        }

        // Update file status to extracted
        const { error: extractedErr } = await supabase
          .from('files')
          .update({ intake_status: 'extracted', quote_id: quoteRow.id })
          .eq('id', fileId)
        if (extractedErr) {
          console.error('Failed to update file status to extracted:', extractedErr)
        }

        // Calculate assumption count (Gate 1 + 2, not excluded)
        const unresolvedCount = assumptions.filter((a) => a.gate !== 3).length

        const completeData: CompleteEvent = {
          stage: 'complete',
          message: `Draft quote ready — ${unresolvedCount} assumption${unresolvedCount !== 1 ? 's' : ''} need your review.`,
          pct: 100,
          quote_id: quoteRow.id,
          assumption_count: unresolvedCount,
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
