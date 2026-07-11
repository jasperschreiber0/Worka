// Edge runtime — no serverless timeout, SSE can stream indefinitely
export const runtime = 'edge'

import { NextRequest } from 'next/server'
import { getAuthenticatedBuilderId } from '@/lib/auth/api-auth'

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
  { stage: 'uploading',             message: 'Uploading plans...',                    pct: 5  },
  { stage: 'reading',               message: 'Reading file...',                       pct: 15 },
  { stage: 'analysing',             message: 'Analysing plans with AI...',            pct: 30 },
  { stage: 'extracting_site',       message: 'Extracting site works & concrete...',   pct: 40 },
  { stage: 'extracting_framing',    message: 'Extracting framing quantities...',      pct: 50 },
  { stage: 'extracting_roofing',    message: 'Extracting roofing...',                 pct: 58 },
  { stage: 'extracting_fitout',     message: 'Extracting fit-out & finishes...',      pct: 68 },
  { stage: 'extracting_electrical', message: 'Extracting electrical & prelims...',    pct: 78 },
  { stage: 'validating',            message: 'Running quantity validation gates...',  pct: 88 },
  { stage: 'building_quote',        message: 'Building draft quote...',               pct: 95 },
]

const STAGE_MESSAGE: Record<string, string> = Object.fromEntries(
  PROGRESS_STAGES.map((s) => [s.stage, s.message])
)

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

  // builder_id is always derived from the authenticated session — never from
  // the query string — so a caller can't watch or trigger another builder's
  // intake pipeline by guessing a fileId.
  const builder_id = await getAuthenticatedBuilderId()
  if (!builder_id) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL
  const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY
  const isRealMode = Boolean(supabaseUrl && supabaseKey)

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

  // ── Real mode: trigger edge function then poll DB ──────────────────────────
  const edgeFnUrl = `${supabaseUrl}/functions/v1/smooth-responder`
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

  // Verify the file actually belongs to this builder before doing anything —
  // this is the check that was previously missing entirely.
  const ownerCheckRes = await fetch(
    `${supabaseUrl}/rest/v1/files?id=eq.${encodeURIComponent(fileId)}&builder_id=eq.${encodeURIComponent(builder_id)}&select=id`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${supabaseKey}`, Accept: 'application/json' } }
  )
  const ownerRows = ownerCheckRes.ok ? (await ownerCheckRes.json() as Array<{ id: string }>) : []
  if (ownerRows.length === 0) {
    return new Response(JSON.stringify({ error: 'File not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  const stream = new ReadableStream({
    async start(controller) {
      const emit = (event: string, data: object) => {
        controller.enqueue(sseEvent(encoder, event, data))
      }

      try {
        // Trigger the edge function — it returns 202 immediately and runs in background
        const triggerRes = await fetch(edgeFnUrl, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${anonKey}`,
          },
          body: JSON.stringify({ file_id: fileId, job_id, builder_id }),
        })

        if (!triggerRes.ok) {
          emit('error', { message: 'Failed to start processing' })
          controller.close()
          return
        }

        // Emit initial stage immediately
        emit('progress', PROGRESS_STAGES[0])

        let lastStage = ''

        // Poll the files table until extraction completes or fails
        for (let attempts = 0; attempts < 120; attempts++) {
          await delay(1500)

          // Inline fetch against Supabase REST API (no Node SDK needed in edge runtime)
          const res = await fetch(
            `${supabaseUrl}/rest/v1/files?id=eq.${encodeURIComponent(fileId)}&builder_id=eq.${encodeURIComponent(builder_id)}&select=intake_status,intake_stage,intake_pct,quote_id,intake_assumption_count`,
            {
              headers: {
                'apikey': anonKey,
                'Authorization': `Bearer ${supabaseKey}`,
                'Accept': 'application/json',
              },
            }
          )

          if (!res.ok) continue

          const rows = await res.json() as Array<{
            intake_status: string
            intake_stage: string | null
            intake_pct: number | null
            quote_id: string | null
            intake_assumption_count: number | null
          }>
          const row = rows[0]
          if (!row) continue

          const stage = row.intake_stage ?? 'uploading'
          const pct = row.intake_pct ?? 5

          // Emit progress only when the stage changes
          if (stage !== lastStage && stage !== 'complete' && stage !== 'failed') {
            const message = STAGE_MESSAGE[stage] ?? stage
            emit('progress', { stage, message, pct })
            lastStage = stage
          }

          if (row.intake_status === 'extracted' && row.quote_id) {
            // The edge function only extracts quantities — resolve rates and
            // quote totals through the 5-tier hierarchy before completing.
            // Idempotent, best-effort: a pricing failure never blocks intake.
            try {
              const { createClient } = await import('@supabase/supabase-js')
              const { ensureQuotePriced } = await import('@/lib/pricing')
              const supabase = createClient(supabaseUrl!, supabaseKey!)
              await ensureQuotePriced(supabase, row.quote_id)
            } catch (pricingErr) {
              console.error('Intake pricing error:', pricingErr)
            }

            const count = row.intake_assumption_count ?? 0
            const completeData: CompleteEvent = {
              stage: 'complete',
              message: `Draft quote ready — ${count} assumption${count !== 1 ? 's' : ''} need your review.`,
              pct: 100,
              quote_id: row.quote_id,
              assumption_count: count,
            }
            emit('complete', completeData)
            controller.close()
            return
          }

          if (row.intake_status === 'failed') {
            emit('error', { message: 'Processing failed — please try again' })
            controller.close()
            return
          }
        }

        // Timed out after ~3 minutes
        emit('error', { message: 'Processing timed out — please try again' })
        controller.close()
      } catch (err) {
        console.error('Intake poll error:', err)
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
