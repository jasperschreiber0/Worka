// ─── LLM provider (infrastructure adapter) ────────────────────────────────────
// A single seam over the Anthropic SDK. Domain services depend on this interface,
// never on the SDK — so they can be unit-tested with a fake provider, and the
// duplicated runTool/runExtraction tool-call plumbing (AbortController timeout,
// maxRetries:0, tool_use extraction) lives in ONE place.

export interface LlmToolCall {
  model?: string
  system: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  blocks: any[]
  userText: string
  toolName: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  schema: any
  maxTokens?: number
  timeoutMs?: number
}

export interface LlmProvider {
  /** Run a single tool-use call and return the tool input (schema-valid), or null. */
  toolCall<T = unknown>(opts: LlmToolCall): Promise<T | null>
}

const DEFAULT_MODEL = 'claude-sonnet-4-6'

/** Real provider backed by the Anthropic SDK. */
export function createAnthropicLlm(apiKey: string): LlmProvider {
  return {
    async toolCall<T>(opts: LlmToolCall): Promise<T | null> {
      const Anthropic = (await import('@anthropic-ai/sdk')).default
      // maxRetries:0 — the SDK's retries reuse an aborted signal and surface as
      // "Retry failed: Request was aborted" when our timer fires.
      const client = new Anthropic({ apiKey, maxRetries: 0 })
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? 180_000)
      try {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const response: any = await (client.messages.create as any)(
          {
            model: opts.model ?? DEFAULT_MODEL,
            max_tokens: opts.maxTokens ?? 8192,
            system: opts.system,
            tools: [{ name: opts.toolName, description: 'Return structured output', input_schema: opts.schema }],
            tool_choice: { type: 'tool', name: opts.toolName },
            messages: [{ role: 'user', content: [...opts.blocks, { type: 'text', text: opts.userText }] }],
          },
          { signal: controller.signal }
        )
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        return (response.content?.find((b: any) => b.type === 'tool_use' && b.name === opts.toolName)?.input ?? null) as T | null
      } finally {
        clearTimeout(timer)
      }
    },
  }
}

/** Fake provider for tests — returns queued responses by tool name. */
export function createFakeLlm(responses: Record<string, unknown>): LlmProvider {
  return {
    async toolCall<T>(opts: LlmToolCall): Promise<T | null> {
      return (responses[opts.toolName] ?? null) as T | null
    },
  }
}
