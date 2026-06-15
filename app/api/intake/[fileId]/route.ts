import { NextRequest } from 'next/server'

// Vercel Pro ceiling. The AI extraction budget (below) is sized to fit two
// attempts comfortably inside this limit. Do not lower without recalculating.
export const maxDuration = 300

// ─── Timing constants ─────────────────────────────────────────────────────────
//
// Budget math (all values in ms):
//   maxDuration       = 300 000
//   PRE_AI_OVERHEAD   =  30 000  (DB read, Supabase download, base64 encode)
//   POST_AI_OVERHEAD  =  10 000  (DB writes, SSE complete event)
//   VERCEL_MARGIN     =  10 000  (safety gap before hard kill)
//   Available for AI  = 300 000 - 30 000 - 10 000 - 10 000 = 250 000
//
//   With 1 retry allowed, each attempt is capped at 110 000ms so that:
//     attempt1 (110s) + attempt2 (110s) + overhead (50s) = 270s < 300s
//
//   If there is insufficient remaining budget for a second attempt the retry
//   is skipped, preventing Vercel from killing the runtime mid-attempt.

const FUNCTION_BUDGET_MS = 280_000   // 280s — 20s inside the 300s hard ceiling
const AI_TIMEOUT_MS      = 110_000   // 110s max per attempt
const MIN_RETRY_BUDGET   =  30_000   // don't start a retry with <30s remaining
const MAX_AI_RETRIES     = 1

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

      const intakeStart = Date.now()
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
        await supabase
          .from('files')
          .update({ intake_status: 'processing' })
          .eq('id', fileId)

        // Stage: reading
        emit('progress', PROGRESS_STAGES[1])

        // Download file from storage
        const { data: fileData, error: downloadErr } = await supabase.storage
          .from('plans')
          .download(fileRow.storage_path)

        if (downloadErr || !fileData) {
          emit('error', { message: 'Failed to read file from storage' })
          await supabase
            .from('files')
            .update({ intake_status: 'failed' })
            .eq('id', fileId)
          controller.close()
          return
        }

        // Stage: analysing
        emit('progress', PROGRESS_STAGES[2])

        // Convert to base64 for Anthropic API
        const fileBuffer = await fileData.arrayBuffer()
        const base64Data = Buffer.from(fileBuffer).toString('base64')
        const isPdf = fileRow.file_type === 'pdf'
        const fileSizeBytes = fileBuffer.byteLength

        const Anthropic = (await import('@anthropic-ai/sdk')).default
        // maxRetries: 0 — SDK retries inherit a dying runtime when Vercel kills the
        // function, producing "Retry timed out: Request was aborted." We manage
        // retries at the route level instead with budget-aware timeouts (see below).
        const client = new Anthropic({ apiKey: anthropicKey, maxRetries: 0 })

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

        // Emit extraction stages while Anthropic processes (cosmetic progress)
        const extractionStages = [3, 4, 5, 6, 7] // indices into PROGRESS_STAGES
        let stageIndex = 0
        const stageEmitter = setInterval(() => {
          if (stageIndex < extractionStages.length) {
            emit('progress', PROGRESS_STAGES[extractionStages[stageIndex]])
            stageIndex++
          }
        }, 2000)

        // SSE heartbeat: keeps the connection visible to browsers and proxies during
        // the silent period after stage emissions end but before Claude responds.
        // Without this, a TCP-level stall produces a frozen progress bar with no
        // error and no timeout — the builder must reload the page.
        const heartbeat = setInterval(() => {
          try {
            controller.enqueue(encoder.encode(': heartbeat\n\n'))
          } catch { /* stream already closed */ }
        }, 15_000)

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

        let anthropicResponse: string
        let aiDurationMs: number | null = null
        let retryCount = 0

        try {
          let lastError: unknown
          while (retryCount <= MAX_AI_RETRIES) {
            const aiStart = Date.now()

            // Budget-aware timeout: cap this attempt to whatever time remains inside
            // FUNCTION_BUDGET_MS. If remaining time is too short to be useful, skip
            // the retry rather than starting an attempt that Vercel will hard-kill —
            // a Vercel kill prevents the error event and DB reset from reaching the
            // client/database, producing silent failures and stuck 'processing' rows.
            const elapsed = Date.now() - intakeStart
            const remaining = FUNCTION_BUDGET_MS - elapsed
            if (remaining < MIN_RETRY_BUDGET) {
              console.error(JSON.stringify({
                event: 'intake:ai:budget_exhausted',
                file_id: fileId,
                file_size_bytes: fileSizeBytes,
                retry_count: retryCount,
                remaining_ms: remaining,
                elapsed_ms: elapsed,
              }))
              throw lastError ?? new Error('Insufficient time budget for AI attempt')
            }

            const attemptTimeout = Math.min(AI_TIMEOUT_MS, remaining - 15_000)
            const abortController = new AbortController()
            const timeoutHandle = setTimeout(() => abortController.abort(), attemptTimeout)

            try {
              const response = await client.messages.create(
                {
                  model: 'claude-sonnet-4-20250514',
                  max_tokens: 4096,
                  // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
                  messages: [{ role: 'user', content: messageContent }],
                },
                { signal: abortController.signal }
              )
              aiDurationMs = Date.now() - aiStart
              anthropicResponse =
                response.content[0].type === 'text' ? response.content[0].text : ''
              console.log(JSON.stringify({
                event: 'intake:ai:success',
                file_id: fileId,
                file_size_bytes: fileSizeBytes,
                ai_duration_ms: aiDurationMs,
                attempt_timeout_ms: attemptTimeout,
                retry_count: retryCount,
                elapsed_ms: Date.now() - intakeStart,
              }))
              break
            } catch (err) {
              aiDurationMs = Date.now() - aiStart
              lastError = err
              const isAbort = err instanceof Error && err.name === 'AbortError'
              console.error(JSON.stringify({
                event: 'intake:ai:fail',
                file_id: fileId,
                file_size_bytes: fileSizeBytes,
                ai_duration_ms: aiDurationMs,
                attempt_timeout_ms: attemptTimeout,
                retry_count: retryCount,
                // 'timeout_controller' = our AbortController fired (file too large or
                //   network stall). 'sdk_or_network' = transient error worth retrying.
                // If Vercel kills the runtime, this catch never runs — the function
                //   is dead. budget_exhausted (above) prevents that scenario.
                abort_source: isAbort ? 'timeout_controller' : 'sdk_or_network',
                error: err instanceof Error ? err.message : String(err),
                elapsed_ms: Date.now() - intakeStart,
              }))
              if (retryCount >= MAX_AI_RETRIES) throw lastError
              // Only retry transient errors, not timeout aborts — a file that timed out
              // on attempt 1 will time out on attempt 2 for the same reason.
              if (isAbort) throw lastError
              retryCount++
              // fresh controller for the retry — never reuse an aborted signal
            } finally {
              clearTimeout(timeoutHandle)
            }
          }
          // anthropicResponse is guaranteed assigned if loop exited without throw
          anthropicResponse = anthropicResponse!
        } finally {
          clearInterval(stageEmitter)
          clearInterval(heartbeat)
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
          await supabase.from('files').update({ intake_status: 'failed' }).eq('id', fileId)
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

          const { data: insertedItems } = await supabase
            .from('quote_line_items')
            .insert(lineItemInserts)
            .select()

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
            await supabase.from('assumptions').insert(assumptionInserts)
          }
        }

        // Update file status to extracted
        await supabase
          .from('files')
          .update({ intake_status: 'extracted', quote_id: quoteRow.id })
          .eq('id', fileId)

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
        const isAbort = err instanceof Error && err.name === 'AbortError'
        const totalElapsed = Date.now() - intakeStart
        console.error(JSON.stringify({
          event: 'intake:worker:fail',
          file_id: fileId,
          stage: 'AI_EXTRACTION_FAILED',
          reason: err instanceof Error ? err.message : String(err),
          abort_source: isAbort ? 'timeout_controller' : 'sdk_or_network',
          elapsed_ms: totalElapsed,
        }))
        // Reset file to 'failed' so it doesn't stay stuck at 'processing' forever.
        // supabase is declared inside the try block so we re-create here. This is
        // intentional — the try block's supabase is out of scope.
        try {
          const { createClient } = await import('@supabase/supabase-js')
          const failureClient = createClient(supabaseUrl!, supabaseKey!)
          await failureClient.from('files').update({ intake_status: 'failed' }).eq('id', fileId)
        } catch { /* best-effort — if Vercel already killed the runtime this won't run */ }
        emit('error', {
          message: isAbort
            ? 'Extraction timed out — the file may be too large. Please try a smaller PDF.'
            : 'Processing failed — please try again',
        })
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
