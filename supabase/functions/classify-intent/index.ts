/**
 * classify-intent — Layer 1 Intent (AI)
 *
 * NOW IMPLEMENTS: multi-action extraction.
 * Returns an ordered list of all actions extracted from a builder message,
 * replacing the previous single-intent contract.
 *
 * Input:  POST { message: string, builder_id: string }
 * Output: { actions: ExtractedAction[], raw_context: Record<string, string> }
 *
 * Confidence < 50 on any action → caller should skip that action.
 *
 * Test messages (must always resolve correctly):
 *   "whats on today"                        → [{ type: morning_brief, confidence: 90+ }]
 *   "add Jack hes a carpenter"              → [{ type: add_worker, entities: { name, role } }]
 *   "new job at 52 Bendigo St help me quote it" → [{ type: create_job, entities: { address } }]
 *   "New rear extension at 52 Bendigo. Client Sarah Jones. Budget $380k. Tell me assumptions." →
 *     [create_job(address, client, budget, scope), review_assumptions]
 */

import Anthropic from 'https://esm.sh/@anthropic-ai/sdk@0.24.0'

type ActionType =
  | 'morning_brief'
  | 'add_worker'
  | 'create_job'
  | 'job_query'
  | 'variation'
  | 'invoice'
  | 'email_draft'
  | 'email_sync_status'
  | 'simulate_email'
  | 'margin_query'
  | 'open_upload_panel'
  | 'review_assumptions'
  | 'unknown'

interface ExtractedAction {
  type: ActionType
  entities: Record<string, string>
  confidence: number
}

interface ExtractActionsRequest {
  message: string
  builder_id: string
}

interface ExtractActionsResponse {
  actions: ExtractedAction[]
  raw_context: Record<string, string>
}

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

const SYSTEM_PROMPT = `You are an action extractor for WorkA — an AI operations manager for Australian residential builders.

Your job is to parse a builder's natural-language message and return ALL actions they are requesting, in priority order, as a JSON object.

### Output format (strict JSON, no other text)
{
  "actions": [
    {
      "type": "<action_type>",
      "entities": { "<key>": "<value>" },
      "confidence": <0-100>
    }
  ],
  "raw_context": { "<key>": "<value>" }
}

### Action types and entity schemas

1. morning_brief — asking about the day, today's schedule. Entities: {}
2. add_worker — adding a new crew member. Entities: { name, role, email?, phone? }
3. create_job — new job/quote at an address. Entities: { address, client_name?, budget_hint?, scope_notes? }
4. job_query — asking about an existing job. Entities: { address?, job_name?, query_type? }
5. variation — variation/change order. Entities: { job_address?, title?, amount?, description? }
6. invoice — invoice/payment query. Entities: { job_address?, amount?, stage? }
7. email_draft — draft an email. Entities: { recipient_name?, job_reference?, intent_hint? }
8. email_sync_status — check if email sync is connected. Entities: {}
9. simulate_email — test email sync. Entities: {}
10. margin_query — job margin/profit query. Entities: { job_address? }
11. open_upload_panel — explicit upload request (only if no create_job action). Entities: {}
12. review_assumptions — asking about unresolved assumptions before quote. Entities: {}
13. unknown — anything else. Entities: {}

### raw_context
Capture any context not mapped to an action: budget without create_job, timeline constraints, etc.

### Rules
- Return ALL actions the builder is requesting — never discard intent
- Order by logical dependency: create_job before open_upload_panel, create_job before review_assumptions
- Confidence < 50: include but mark accurately — caller will skip low-confidence actions
- For create_job: strip leading articles from address; extract budget_hint as numeric string (e.g. "$380,000" → "380000")
- For add_worker: normalise role to lowercase
- ONLY return valid JSON — no prose, no markdown, no explanation`

Deno.serve(async (req: Request): Promise<Response> => {
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS })
  }

  if (req.method !== 'POST') {
    return corsResponse(JSON.stringify({ error: 'Method not allowed' }), 405)
  }

  let body: ExtractActionsRequest
  try {
    body = await req.json() as ExtractActionsRequest
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
      messages: [{ role: 'user', content: message.trim() }],
    })

    const rawText = response.content[0].type === 'text' ? response.content[0].text : ''

    let parsed: ExtractActionsResponse
    try {
      const cleaned = rawText.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
      parsed = JSON.parse(cleaned) as ExtractActionsResponse
    } catch {
      console.error('Failed to parse Claude response:', rawText)
      parsed = { actions: [{ type: 'unknown', entities: {}, confidence: 0 }], raw_context: {} }
    }

    const validTypes: ActionType[] = [
      'morning_brief', 'add_worker', 'create_job', 'job_query', 'variation',
      'invoice', 'email_draft', 'email_sync_status', 'simulate_email',
      'margin_query', 'open_upload_panel', 'review_assumptions', 'unknown',
    ]

    const actions: ExtractedAction[] = Array.isArray(parsed.actions)
      ? parsed.actions.map((a) => ({
          type: validTypes.includes(a.type) ? a.type : 'unknown' as ActionType,
          entities: a.entities && typeof a.entities === 'object' ? a.entities : {},
          confidence: typeof a.confidence === 'number' ? Math.min(100, Math.max(0, a.confidence)) : 0,
        }))
      : [{ type: 'unknown', entities: {}, confidence: 0 }]

    const result: ExtractActionsResponse = {
      actions,
      raw_context: parsed.raw_context ?? {},
    }

    return corsResponse(JSON.stringify(result))
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error'
    console.error('classify-intent error:', msg)
    return corsResponse(JSON.stringify({ error: 'Extraction failed', detail: msg }), 500)
  }
})
