/**
 * classify-intent — Layer 1 Intent (AI)
 *
 * Classifies builder natural-language messages into structured intents
 * using Claude. This is the brain of the four-layer architecture.
 *
 * Input:  POST { message: string, builder_id: string }
 * Output: { intent, entities, confidence, raw_message }
 *
 * Supported intents:
 *   morning_brief | add_worker | new_job | job_query |
 *   variation     | invoice    | unknown
 *
 * Test messages (must always resolve correctly):
 *   "whats on today"                        → morning_brief
 *   "add Jack hes a carpenter"              → add_worker { name: "Jack", role: "carpenter" }
 *   "new job at 52 Bendigo St help me quote it" → new_job { address: "52 Bendigo St" }
 */

import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.24.0'

// ─── Types ────────────────────────────────────────────────────

type Intent =
  | 'morning_brief'
  | 'add_worker'
  | 'new_job'
  | 'job_query'
  | 'variation'
  | 'invoice'
  | 'unknown'

interface ClassifyIntentRequest {
  message: string
  builder_id: string
}

interface ClassifyIntentResponse {
  intent: Intent
  entities: Record<string, string>
  confidence: number
  raw_message: string
}

// ─── CORS headers ─────────────────────────────────────────────

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
}

function corsResponse(body: string, status = 200): Response {
  return new Response(body, {
    status,
    headers: { ...CORS_HEADERS, 'Content-Type': 'application/json' },
  })
}

// ─── System prompt ────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an intent classifier for WorkA — an AI operations manager for Australian residential builders.

Your only job is to parse a builder's natural-language message and return a JSON object with:
- intent: one of the 7 values below
- entities: a flat key/value object with relevant extracted data
- confidence: a number 0-100 representing your classification certainty

### Intent definitions and entity schemas

1. morning_brief
   Trigger: asking about the day, today's schedule, what's on, daily summary, briefing
   Entities: {} (none required)
   Examples: "whats on today", "give me a rundown", "morning brief", "what do i have today"

2. add_worker
   Trigger: adding, inviting, creating a new crew member, worker, tradesperson or employee
   Entities: { name: string, role: string, email?: string, phone?: string }
   Examples: "add Jack hes a carpenter", "invite Sarah as site manager", "new worker Tom plumber 0412345678"

3. new_job
   Trigger: creating a new job, project, quoting a NEW address not yet in the system
   Entities: { address: string, client_name?: string }
   Examples: "new job at 52 Bendigo St help me quote it", "start a job for the Hendersons at 10 Oak Ave"
   NOT this: "I need to quote", "quote the Fitzroy job", "I need to do a quote" — those are job_query

4. job_query
   Trigger: asking about an existing job, its status, timeline, workers on site — also vague quoting requests that reference existing work
   Entities: { address?: string, job_id?: string, query_type?: string }
   Examples: "what's happening on the Miller job", "status of 14 Smith St", "I need to quote", "I need to do a quote", "quote for the Fitzroy job"

5. variation
   Trigger: creating, logging or asking about a variation, change order, scope change
   Entities: { job_address?: string, title?: string, amount?: string, description?: string }
   Examples: "log a variation on the Oak Ave job — extra retaining wall $2400"

6. invoice
   Trigger: creating, sending, asking about invoices or payments
   Entities: { job_address?: string, amount?: string, stage?: string }
   Examples: "send invoice for slab stage on Bendigo St", "invoice the Smiths $15000 for frame stage"

7. unknown
   Trigger: anything that doesn't match the above
   Entities: {}

### Rules
- ONLY return valid JSON — no prose, no markdown, no explanation
- If confidence is below 40, set intent to "unknown"
- For add_worker: normalise role to lowercase (e.g. "Carpenter" → "carpenter")
- For new_job: extract the cleanest possible address without surrounding words
- For addresses: strip leading articles ("at", "for", "on") and trailing instructions ("help me quote it")

### Output format (strict JSON, no other text)
{
  "intent": "<intent_value>",
  "entities": { "<key>": "<value>" },
  "confidence": <0-100>
}`

// ─── Handler ──────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405)
  }

  let body: ClassifyIntentRequest
  try {
    body = await req.json() as ClassifyIntentRequest
  } catch {
    return corsResponse(JSON.stringify({ error: 'Invalid JSON body' }), 400)
  }

  const { message, builder_id } = body

  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return corsResponse(JSON.stringify({ error: 'message is required' }), 400)
  }

  if (!builder_id || typeof builder_id !== 'string') {
    return corsResponse(JSON.stringify({ error: 'builder_id is required' }), 400)
  }

  const apiKey = Deno.env.get('ANTHROPIC_API_KEY')
  if (!apiKey) {
    return corsResponse(JSON.stringify({ error: 'ANTHROPIC_API_KEY not configured' }), 500)
  }

  const anthropic = new Anthropic({ apiKey })

  try {
    const response = await anthropic.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 512,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: message.trim(),
        },
      ],
    })

    const rawText = response.content[0].type === 'text' ? response.content[0].text : ''

    // Parse the JSON from Claude's response
    let parsed: { intent: Intent; entities: Record<string, string>; confidence: number }
    try {
      // Strip any accidental markdown code fences
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      parsed = JSON.parse(cleaned)
    } catch {
      // Fallback if Claude returned malformed JSON
      console.error('Failed to parse Claude response:', rawText)
      parsed = { intent: 'unknown', entities: {}, confidence: 0 }
    }

    // Validate and sanitise
    const validIntents: Intent[] = [
      'morning_brief', 'add_worker', 'new_job', 'job_query',
      'variation', 'invoice', 'unknown',
    ]
    const intent: Intent = validIntents.includes(parsed.intent) ? parsed.intent : 'unknown'
    const entities: Record<string, string> = parsed.entities && typeof parsed.entities === 'object'
      ? parsed.entities as Record<string, string>
      : {}
    const confidence = typeof parsed.confidence === 'number'
      ? Math.min(100, Math.max(0, parsed.confidence))
      : 0

    const result: ClassifyIntentResponse = {
      intent,
      entities,
      confidence,
      raw_message: message.trim(),
    }

    return corsResponse(JSON.stringify(result))
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : 'Unknown error'
    console.error('classify-intent error:', message)
    return corsResponse(JSON.stringify({ error: 'Classification failed', detail: message }), 500)
  }
})
