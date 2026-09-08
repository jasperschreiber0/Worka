// OpenAI Responses adapter. Keeps the existing gateway's metering and checkpoints.
export const ESTIMATION_MODEL = 'gpt-5.4-2026-03-05'
type Block = { type: string; text?: string; source?: { type: string; media_type: string; data: string } }
type Request = { model?: string; tool_choice?: unknown; system: string; max_tokens: number; tools: Array<{name: string; description?: string; input_schema: unknown}>; messages: Array<{content: Block[]}> }

export function openAIRequest(request: Request) {
  const tool = request.tools[0]
  if (request.tools.length !== 1 || !tool) throw new Error('Exactly one estimation tool is required')
  const content = request.messages.flatMap(message => message.content.map(block => {
    if (block.type === 'text' && typeof block.text === 'string') return { type: 'input_text', text: block.text }
    if (block.source?.type === 'base64' && block.source.data) {
      const data = `data:${block.source.media_type};base64,${block.source.data}`
      if (block.type === 'image') return { type: 'input_image', image_url: data, detail: 'high' }
      if (block.type === 'document' && block.source.media_type === 'application/pdf') return { type: 'input_file', filename: 'plan.pdf', file_data: data }
    }
    throw new Error(`Unsupported estimation input type: ${block.type}`)
  }))
  return { model: ESTIMATION_MODEL, store: false, instructions: request.system,
    input: [{role: 'user', content}], max_output_tokens: request.max_tokens,
    reasoning: {effort: 'none'}, parallel_tool_calls: false,
    tools: [{type: 'function', name: tool.name, description: tool.description, parameters: tool.input_schema, strict: false}],
    tool_choice: {type: 'function', name: tool.name} }
}

export function normalizeOpenAIResponse(raw: any, name: string) {
  const usage = raw.usage
  if (!usage || !Number.isFinite(usage.input_tokens) || !Number.isFinite(usage.output_tokens)) throw new Error('OpenAI response has no valid usage accounting')
  // Return incomplete responses to the gateway for accounting; the caller rejects them.
  if (raw.status !== 'completed') return {id: raw.id, usage, stop_reason: 'max_tokens', content: []}
  const calls = (raw.output ?? []).filter((item: any) => item.type === 'function_call')
  if (calls.length !== 1 || calls[0].name !== name) return {id: raw.id, usage, stop_reason: 'invalid_tool_response', content: []}
  let input: unknown
  try { input = JSON.parse(calls[0].arguments) } catch { return {id: raw.id, usage, stop_reason: 'invalid_tool_response', content: []} }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {id: raw.id, usage, stop_reason: 'invalid_tool_response', content: []}
  return {id: raw.id, usage, stop_reason: 'tool_use', content: [{type: 'tool_use', name, input}]}
}

export class OpenAIEstimationClient {
  private apiKey: string
  private transport: typeof fetch
  constructor(apiKey: string, transport: typeof fetch = fetch) { this.apiKey = apiKey; this.transport = transport }
  messages = { create: async (request: Request, options: {signal?: AbortSignal}) => {
    const response = await this.transport('https://api.openai.com/v1/responses', {
      method: 'POST', headers: {'Authorization': `Bearer ${this.apiKey}`, 'Content-Type': 'application/json'},
      body: JSON.stringify(openAIRequest(request)), signal: options.signal,
    })
    const raw = await response.json()
    if (!response.ok) {
      const code = raw.error?.code ?? raw.error?.type
      // Do not log provider bodies: they can contain source text or credentials.
      throw Object.assign(new Error(`OpenAI request failed (${response.status}; ${code ?? 'unknown'})`), {
        status: code === 'insufficient_quota' ? 400 : response.status,
        error: {type: code === 'insufficient_quota' ? 'invalid_request_error' : code},
        ...(code === 'insufficient_quota' ? {message: 'OpenAI billing credit exhausted'} : {}),
      })
    }
    return normalizeOpenAIResponse(raw, request.tools[0].name)
  }}
}
