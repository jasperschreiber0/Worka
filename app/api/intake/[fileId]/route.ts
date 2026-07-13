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

interface ClarificationQuestion {
  id: string
  question: string
  reason: string
}

interface NeedsClarificationEvent {
  stage: 'needs_clarification'
  message: string
  questions: ClarificationQuestion[]
}

// ─── Progress stages — mirrors supabase/functions/smooth-responder's real
// pipeline stages (Document Intelligence -> Project Understanding -> Scope
// Reasoning -> Gap Detection -> Estimate Generation). Demo mode below plays
// these back on a timer since there is no live reasoning engine to poll. ────

const PROGRESS_STAGES: ProgressEvent[] = [
  { stage: 'uploading',              message: 'Uploading documents...',                          pct: 5  },
  { stage: 'reading',                message: 'Reading documents...',                             pct: 12 },
  { stage: 'classifying_documents',  message: 'Classifying documents...',                          pct: 25 },
  { stage: 'understanding_project',  message: 'Building project understanding...',                 pct: 40 },
  { stage: 'reasoning_scope',        message: 'Reasoning about scope, trade by trade...',           pct: 55 },
  { stage: 'detecting_gaps',         message: 'Checking for missing information...',                pct: 65 },
  { stage: 'generating_estimate',    message: 'Generating the estimate...',                         pct: 85 },
  { stage: 'validating',             message: 'Running quality assurance...',                       pct: 92 },
  { stage: 'building_quote',         message: 'Building draft quote...',                            pct: 97 },
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
  const siblingsParam = searchParams.get('siblings') ?? ''
  const sibling_file_ids = siblingsParam ? siblingsParam.split(',').filter(Boolean) : []
  // Set by IntakeProgress when reconnecting after /clarify already re-triggered
  // the engine with resume: true — skip the trigger below, poll only.
  const alreadyTriggered = searchParams.get('resumed') === '1'
  // Rides along in the URL from the client's first connection and persists
  // through the browser's automatic EventSource reconnects (same URL each
  // time) — lets this handler track overall elapsed time across the whole
  // chain of connections Vercel's hard execution ceiling forces us into,
  // not just this one connection's slice.
  const startedAtParam = Number(searchParams.get('started_at'))
  const overallStartedAt = Number.isFinite(startedAtParam) && startedAtParam > 0 ? startedAtParam : Date.now()

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
            await delay(500)
            controller.enqueue(sseEvent(encoder, 'progress', stage))
          }

          await delay(500)

          const completeData: CompleteEvent = {
            stage: 'complete',
            message: 'Estimate ready — 3 assumptions need your review.',
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

  // ── Real mode: trigger the estimating engine then poll DB ──────────────────
  const edgeFnUrl = `${supabaseUrl}/functions/v1/smooth-responder`
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''

  // Verify the file actually belongs to this builder before doing anything —
  // this is the check that was previously missing entirely.
  const ownerCheckRes = await fetch(
    `${supabaseUrl}/rest/v1/files?id=eq.${encodeURIComponent(fileId)}&builder_id=eq.${encodeURIComponent(builder_id)}&select=id,intake_status`,
    { headers: { apikey: anonKey, Authorization: `Bearer ${supabaseKey}`, Accept: 'application/json' } }
  )
  const ownerRows = ownerCheckRes.ok ? (await ownerCheckRes.json() as Array<{ id: string; intake_status: string | null }>) : []
  if (ownerRows.length === 0) {
    return new Response(JSON.stringify({ error: 'File not found' }), {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
    })
  }
  // A run is already in flight server-side once intake_status leaves its
  // pre-trigger value — this can be true even when the client's `resumed`
  // flag is false, e.g. the browser's EventSource silently reconnected
  // (network blip, an edge-runtime stream cutoff) without going through the
  // clarify flow. Trusting only the client flag here caused every reconnect
  // to fire a brand new trigger, restarting Stages 1-3 from scratch each
  // time and never reaching estimate generation.
  const alreadyProcessing = !['uploaded', null].includes(ownerRows[0].intake_status)

  const stream = new ReadableStream({
    async start(controller) {
      const connectionStartedAt = Date.now()
      const emit = (event: string, data: object) => {
        controller.enqueue(sseEvent(encoder, event, data))
      }

      try {
        if (!alreadyTriggered && !alreadyProcessing) {
          // Trigger the estimating engine — it returns 202 immediately and runs in background
          const triggerRes = await fetch(edgeFnUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${anonKey}`,
            },
            body: JSON.stringify({ file_id: fileId, job_id, builder_id, sibling_file_ids }),
          })

          if (!triggerRes.ok) {
            emit('error', { message: 'Failed to start processing' })
            controller.close()
            return
          }
        }

        // Emit initial stage immediately
        emit('progress', PROGRESS_STAGES[0])

        let lastStage = ''

        // Poll the files table until extraction completes, pauses for
        // clarification, or fails.
        //
        // Vercel forcibly kills this function at a hard 300s ceiling
        // regardless of any timeout we set here -- confirmed via
        // "Vercel Runtime Timeout Error: Task timed out after 300 seconds"
        // in production. The reasoning-first engine's three large sequential
        // Claude calls can genuinely exceed that on a real project, so
        // instead of waiting to be killed, this connection self-closes
        // cleanly at a safe margin under 300s and tells the client to open a
        // fresh connection (see the 'reconnect' emit below) rather than
        // treating the close as a failure. The retrigger-prevention check
        // above means that reconnect only polls, never restarts the
        // pipeline, so the underlying Supabase-side run (independent of
        // this Vercel connection) keeps going undisturbed across as many
        // reconnect cycles as it needs. OVERALL_TIMEOUT_MS is the real
        // give-up point, tracked across that whole chain via
        // overallStartedAt, not per-connection.
        const CONNECTION_SAFETY_MARGIN_MS = 260_000
        const OVERALL_TIMEOUT_MS = 15 * 60_000
        for (let attempts = 0; ; attempts++) {
          if (Date.now() - overallStartedAt > OVERALL_TIMEOUT_MS) {
            emit('error', { message: 'Processing timed out — please try again' })
            controller.close()
            return
          }
          if (Date.now() - connectionStartedAt > CONNECTION_SAFETY_MARGIN_MS) {
            // Deliberate close well before Vercel's hard kill. A plain close
            // still fires EventSource's native 'error' (it can't tell a
            // deliberate close from a real connection loss), so emit an
            // explicit 'reconnect' event first — IntakeProgress listens for
            // it and opens a fresh connection itself instead of treating
            // this as a failure.
            emit('reconnect', {})
            controller.close()
            return
          }
          await delay(1500)

          const res = await fetch(
            `${supabaseUrl}/rest/v1/files?id=eq.${encodeURIComponent(fileId)}&builder_id=eq.${encodeURIComponent(builder_id)}&select=intake_status,intake_stage,intake_pct,quote_id,intake_assumption_count,failure_stage,failure_reason`,
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
            failure_stage: string | null
            failure_reason: string | null
          }>
          const row = rows[0]
          if (!row) continue

          const stage = row.intake_stage ?? 'uploading'
          const pct = row.intake_pct ?? 5

          if (stage !== lastStage && !['complete', 'failed', 'awaiting_clarification'].includes(stage)) {
            const message = STAGE_MESSAGE[stage] ?? stage
            emit('progress', { stage, message, pct })
            lastStage = stage
          }

          // Stage 4/5: the engine found a blocking gap and stopped before
          // generating an estimate — surface the questions and end the stream.
          if (row.intake_status === 'needs_info') {
            const qRes = await fetch(
              `${supabaseUrl}/rest/v1/clarifying_questions?job_id=eq.${encodeURIComponent(job_id)}&status=eq.open&blocking=eq.true&select=id,question,reason`,
              {
                headers: {
                  'apikey': anonKey,
                  'Authorization': `Bearer ${supabaseKey}`,
                  'Accept': 'application/json',
                },
              }
            )
            const questions = qRes.ok ? await qRes.json() as ClarificationQuestion[] : []
            const needsClarification: NeedsClarificationEvent = {
              stage: 'needs_clarification',
              message: 'A few things would materially change this estimate — answer these before WorkA prices the job.',
              questions,
            }
            emit('needs_clarification', needsClarification)
            controller.close()
            return
          }

          if (row.intake_status === 'extracted' && row.quote_id) {
            // The reasoning engine only produces quantities — resolve rates
            // through the 5-tier hierarchy, then run the Stage 8 QA pass.
            // Idempotent, best-effort: neither failure blocks intake.
            try {
              const { createClient } = await import('@supabase/supabase-js')
              const { ensureQuotePriced } = await import('@/lib/pricing')
              const { runQualityAssurance } = await import('@/lib/estimating/qa')
              const supabase = createClient(supabaseUrl!, supabaseKey!)
              await ensureQuotePriced(supabase, row.quote_id)
              await runQualityAssurance(supabase, row.quote_id, job_id)
            } catch (pricingErr) {
              console.error('Intake pricing/QA error:', pricingErr)
            }

            const count = row.intake_assumption_count ?? 0
            const completeData: CompleteEvent = {
              stage: 'complete',
              message: `Estimate ready — ${count} assumption${count !== 1 ? 's' : ''} need your review.`,
              pct: 100,
              quote_id: row.quote_id,
              assumption_count: count,
            }
            emit('complete', completeData)
            controller.close()
            return
          }

          if (row.intake_status === 'failed') {
            console.error('Intake failed:', fileId, row.failure_stage, row.failure_reason)
            emit('error', { message: 'Processing failed — please try again' })
            controller.close()
            return
          }
        }
        // Unreachable: the loop above only exits via an explicit return
        // (complete / needs_clarification / failed / overall timeout / safe
        // self-close for reconnect).
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
