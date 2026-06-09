import { NextRequest } from 'next/server'
import {
  applyValidationGates,
  computeConfidenceScore,
  computeEstimateTotals,
  DEFAULT_CONTINGENCY_PCT,
  DEFAULT_GST_PCT,
  DEFAULT_MARGIN_PCT,
  extractItemsFromDocument,
  mergeExtractedItems,
  tradeCategoryName,
  type ExtractedItem,
  type IntakeDocument,
  type ValidatedItem,
} from '@/lib/estimate'
import {
  getPendingFile,
  removePendingFile,
  storeGeneratedQuote,
} from '@/lib/intake-store'
import { getDemoJobSnapshot } from '@/lib/job-snapshot-demo'
import type { DemoQuoteLineItem } from '@/lib/quote-demo'

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
}

// ─── Progress stages (canned demo pipeline) ──────────────────────────────────

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

function sseResponse(stream: ReadableStream): Response {
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  })
}

// ─── 5-tier rate hierarchy lookup (Supabase mode only) ────────────────────────
// Tier 1 builder_learned_rates → 2 builder_rate_preferences →
// 3 builder_supplier_rates → 4 cost_rates (state-aware) →
// 5 network_rate_aggregates (P50). Falls back to the AI's market rate.

async function resolveRatesFromHierarchy(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  builderId: string,
  state: string | null,
  items: ExtractedItem[]
): Promise<ExtractedItem[]> {
  const keys = Array.from(
    new Set(items.map((i) => i.line_item_key).filter((k): k is string => Boolean(k)))
  )
  if (keys.length === 0) return items

  const tiers: Array<Map<string, number>> = []
  try {
    const [learned, prefs, supplier, costRates, network] = await Promise.all([
      supabase.from('builder_learned_rates').select('line_item_key, rate').eq('builder_id', builderId).in('line_item_key', keys),
      supabase.from('builder_rate_preferences').select('line_item_key, rate').eq('builder_id', builderId).in('line_item_key', keys),
      supabase.from('builder_supplier_rates').select('line_item_key, rate').eq('builder_id', builderId).in('line_item_key', keys),
      supabase.from('cost_rates').select('line_item_key, rate, state').in('line_item_key', keys),
      supabase.from('network_rate_aggregates').select('line_item_key, rate_p50, state').in('line_item_key', keys),
    ])

    const toMap = (rows: Array<{ line_item_key: string; rate?: number; rate_p50?: number | null; state?: string | null }> | null, preferState = false) => {
      const map = new Map<string, number>()
      for (const row of rows ?? []) {
        const rate = row.rate ?? row.rate_p50
        if (rate === null || rate === undefined) continue
        // State-specific rows win over national defaults
        if (map.has(row.line_item_key) && preferState && row.state !== state) continue
        if (!map.has(row.line_item_key) || (preferState && row.state === state)) {
          map.set(row.line_item_key, rate)
        }
      }
      return map
    }

    tiers.push(
      toMap(learned.data),
      toMap(prefs.data),
      toMap(supplier.data),
      toMap(costRates.data, true),
      toMap(network.data, true)
    )
  } catch {
    // Rate tables unavailable — keep AI market rates
    return items
  }

  return items.map((item) => {
    if (!item.line_item_key) return item
    for (const tier of tiers) {
      const rate = tier.get(item.line_item_key)
      if (rate !== undefined) {
        return { ...item, rate }
      }
    }
    return item
  })
}

// ─── GET /api/intake/[fileId] ─────────────────────────────────────────────────
// Query params:
//   file_ids   — optional comma-separated list of additional file ids to process
//                together as one plan set (the path fileId is always included)
//   job_id     — job the quote belongs to
//   builder_id — owning builder

export async function GET(
  req: NextRequest,
  { params }: { params: { fileId: string } }
): Promise<Response> {
  const { fileId } = params
  const { searchParams } = new URL(req.url)
  const job_id = searchParams.get('job_id') ?? ''
  const builder_id =
    searchParams.get('builder_id') ?? '00000000-0000-0000-0000-000000000001'

  const extraIds = (searchParams.get('file_ids') ?? '')
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean)
  const fileIds = Array.from(new Set([fileId, ...extraIds]))

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const hasSupabase = Boolean(supabaseUrl && supabaseKey)

  const encoder = new TextEncoder()

  // ── Canned demo mode (no AI key) ───────────────────────────────────────────
  if (!anthropicKey) {
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
    return sseResponse(stream)
  }

  // ── AI estimate pipeline (with or without Supabase) ─────────────────────────
  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: string, data: object) => {
        controller.enqueue(sseEvent(encoder, event, data))
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let supabase: any = null

      try {
        emit('progress', { stage: 'uploading', message: 'Preparing plan set...', pct: 4 })

        // ── Gather documents ────────────────────────────────────────────────
        const docs: IntakeDocument[] = []
        let builderState: string | null = null

        if (hasSupabase) {
          const { createClient } = await import('@supabase/supabase-js')
          supabase = createClient(supabaseUrl!, supabaseKey!)

          const { data: builderRow } = await supabase
            .from('builders')
            .select('state')
            .eq('id', builder_id)
            .single()
          builderState = builderRow?.state ?? null

          const { data: fileRows, error: fileErr } = await supabase
            .from('files')
            .select('*')
            .in('id', fileIds)

          if (fileErr || !fileRows || fileRows.length === 0) {
            emit('error', { message: 'Files not found' })
            controller.close()
            return
          }

          await supabase
            .from('files')
            .update({ intake_status: 'processing' })
            .in('id', fileIds)

          emit('progress', { stage: 'reading', message: 'Reading files from storage...', pct: 8 })

          for (const fileRow of fileRows) {
            const { data: fileData, error: downloadErr } = await supabase.storage
              .from('plans')
              .download(fileRow.storage_path)
            if (downloadErr || !fileData) {
              emit('error', { message: `Failed to read ${fileRow.filename} from storage` })
              await supabase.from('files').update({ intake_status: 'failed' }).in('id', fileIds)
              controller.close()
              return
            }
            const buffer = await fileData.arrayBuffer()
            docs.push({
              filename: fileRow.filename,
              media_type: fileRow.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg',
              base64: Buffer.from(buffer).toString('base64'),
            })
          }
        } else {
          // In-memory mode — files were stored by /api/upload
          emit('progress', { stage: 'reading', message: 'Reading uploaded files...', pct: 8 })
          for (const id of fileIds) {
            const pending = getPendingFile(id)
            if (pending) {
              docs.push({
                filename: pending.filename,
                media_type: pending.media_type,
                base64: pending.base64,
              })
            }
          }
          if (docs.length === 0) {
            emit('error', {
              message: 'Uploaded files are no longer available — please upload them again.',
            })
            controller.close()
            return
          }
        }

        const state = builderState ?? 'NSW'

        // ── Extract line items per document ─────────────────────────────────
        const batches: ExtractedItem[][] = []
        const skippedNotes: string[] = []
        const extractSpan = { from: 12, to: 74 }

        for (let i = 0; i < docs.length; i++) {
          const doc = docs[i]
          emit('progress', {
            stage: `extracting_doc_${i}`,
            message: `Analysing ${doc.filename} (${i + 1} of ${docs.length})...`,
            pct: Math.round(
              extractSpan.from + ((extractSpan.to - extractSpan.from) * i) / docs.length
            ),
          })
          try {
            const { items, skipped } = await extractItemsFromDocument(anthropicKey, doc, state)
            if (skipped) skippedNotes.push(skipped)
            batches.push(items)
          } catch (err) {
            console.error(`Extraction failed for ${doc.filename}:`, err)
            skippedNotes.push(`${doc.filename} could not be analysed`)
          }
        }

        if (batches.every((b) => b.length === 0)) {
          emit('error', {
            message:
              'No estimate line items could be extracted from the uploaded documents — please check the files and try again.',
          })
          if (supabase) {
            await supabase.from('files').update({ intake_status: 'failed' }).in('id', fileIds)
          }
          controller.close()
          return
        }

        // ── Merge, price, validate ──────────────────────────────────────────
        emit('progress', { stage: 'pricing', message: 'Pricing line items against your rates...', pct: 78 })

        let merged = mergeExtractedItems(batches)
        if (supabase) {
          merged = await resolveRatesFromHierarchy(supabase, builder_id, builderState, merged)
        }

        emit('progress', { stage: 'validating', message: 'Running quantity validation gates...', pct: 86 })
        const { validated, assumptions } = applyValidationGates(merged)

        emit('progress', { stage: 'building_quote', message: 'Building estimate with contingency, margin & GST...', pct: 94 })

        const estimate = computeEstimateTotals(
          validated,
          DEFAULT_CONTINGENCY_PCT,
          DEFAULT_MARGIN_PCT,
          DEFAULT_GST_PCT
        )
        const confidenceScore = computeConfidenceScore(validated)
        const unresolvedCount = validated.filter(
          (i) => i.is_assumption && i.assumption_status === 'unresolved'
        ).length

        // ── Persist ─────────────────────────────────────────────────────────
        let quoteId: string

        if (supabase) {
          quoteId = await persistToSupabase(
            supabase,
            { job_id, builder_id, fileIds },
            validated,
            assumptions,
            estimate.total_inc_gst,
            confidenceScore
          )
          if (!quoteId) {
            emit('error', { message: 'Failed to create quote' })
            await supabase.from('files').update({ intake_status: 'failed' }).in('id', fileIds)
            controller.close()
            return
          }
        } else {
          quoteId = crypto.randomUUID()
          const jobAddress =
            getDemoJobSnapshot(job_id)?.job.address ?? 'Uploaded plan set'
          storeGeneratedQuote({
            quote: {
              id: quoteId,
              job_id,
              job_address: jobAddress,
              builder_id,
              status: 'pending_review',
              total_cost: estimate.total_inc_gst,
              margin_pct: estimate.margin_pct,
              confidence_score: confidenceScore,
              version: 1,
              created_at: new Date().toISOString(),
              contingency_pct: estimate.contingency_pct,
              gst_pct: estimate.gst_pct,
            },
            items: validated.map((item, idx): DemoQuoteLineItem => ({
              id: `gen-${quoteId}-${idx}`,
              quote_id: quoteId,
              trade_category_id: item.trade_category_id,
              trade_category_name: tradeCategoryName(item.trade_category_id),
              description: item.description,
              quantity: item.quantity,
              unit: item.unit,
              rate: item.rate,
              total: item.total,
              confidence: item.confidence,
              dimensions_string: item.dimensions_string,
              is_assumption: item.is_assumption,
              assumption_status: item.assumption_status,
              item_type: item.item_type,
              pricing_basis: item.pricing_basis,
              notes: item.notes,
            })),
            estimate,
          })
          for (const id of fileIds) removePendingFile(id)
        }

        const pcCount = validated.filter((i) => i.item_type !== 'measured').length
        const parts = [
          `Draft estimate ready — ${validated.length} line items`,
          pcCount > 0 ? `${pcCount} PC/provisional allowance${pcCount !== 1 ? 's' : ''}` : null,
          unresolvedCount > 0
            ? `${unresolvedCount} assumption${unresolvedCount !== 1 ? 's' : ''} need your review`
            : 'no assumptions outstanding',
          ...skippedNotes,
        ].filter(Boolean)

        const completeData: CompleteEvent = {
          stage: 'complete',
          message: `${parts.join(', ')}.`,
          pct: 100,
          quote_id: quoteId,
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

  return sseResponse(stream)
}

// ─── Supabase persistence ─────────────────────────────────────────────────────

async function persistToSupabase(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  ctx: { job_id: string; builder_id: string; fileIds: string[] },
  validated: ValidatedItem[],
  assumptions: Array<{ description: string; gate: number; message: string }>,
  totalIncGst: number,
  confidenceScore: number
): Promise<string> {
  const baseQuote = {
    job_id: ctx.job_id,
    builder_id: ctx.builder_id,
    status: 'draft',
    total_cost: totalIncGst,
    margin_pct: DEFAULT_MARGIN_PCT,
    confidence_score: confidenceScore,
    version: 1,
  }

  // Try with the estimate columns from migration 008; retry without them if
  // the migration hasn't been applied yet.
  let quoteRow =
    (
      await supabase
        .from('quotes')
        .insert({ ...baseQuote, contingency_pct: DEFAULT_CONTINGENCY_PCT, gst_pct: DEFAULT_GST_PCT })
        .select()
        .single()
    ).data ?? null
  if (!quoteRow) {
    quoteRow = (await supabase.from('quotes').insert(baseQuote).select().single()).data ?? null
  }
  if (!quoteRow) return ''

  const baseItems = validated.map((item) => ({
    quote_id: quoteRow.id,
    trade_category_id: item.trade_category_id,
    description: item.description,
    quantity: item.quantity,
    unit: item.unit,
    rate: item.rate,
    total: item.total,
    confidence: item.confidence,
    dimensions_string: item.dimensions_string,
    is_assumption: item.is_assumption,
    assumption_status: item.assumption_status,
  }))

  const itemsWithEstimateFields = baseItems.map((row, idx) => ({
    ...row,
    item_type: validated[idx].item_type,
    pricing_basis: validated[idx].pricing_basis,
    notes: validated[idx].notes,
  }))

  let insertedItems =
    (await supabase.from('quote_line_items').insert(itemsWithEstimateFields).select()).data ?? null
  if (!insertedItems) {
    insertedItems = (await supabase.from('quote_line_items').insert(baseItems).select()).data ?? null
  }

  if (insertedItems && assumptions.length > 0) {
    const assumptionInserts = assumptions.map((a) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const matchingItem = insertedItems.find((li: any) => li.description === a.description)
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

  await supabase
    .from('files')
    .update({ intake_status: 'extracted', quote_id: quoteRow.id })
    .in('id', ctx.fileIds)

  return quoteRow.id
}
