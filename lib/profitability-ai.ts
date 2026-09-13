import Anthropic from '@anthropic-ai/sdk'
import { guardedClaudeCall } from '@/supabase/functions/smooth-responder/ai-gateway'
import {
  OpenAIEstimationClient,
  ESTIMATION_MODEL,
} from '@/supabase/functions/smooth-responder/openai-provider'
import { gatewaySupabase } from './ai-gateway-client'
// Provider/source adapters feed the same evidence ledger; OAuth is outside this MVP.
export interface CorrespondenceSource {
  provider: 'paste' | 'upload' | 'gmail' | 'outlook' | 'forward'
  externalId?: string
  threadId?: string
  participants?: string[]
  sourceName?: string
  text: string
}
export interface AccountingProvider {
  provider: 'spreadsheet' | 'xero'
  externalId?: string
  importedAt: string
  taxBasis: 'exclusive' | 'inclusive'
}
export async function intelligenceAI(
  builder: string,
  task: string,
  system: string,
  input: unknown,
  schema: Record<string, unknown>,
) {
  const openai = process.env.OPENAI_API_KEY
  if (!openai && !process.env.ANTHROPIC_API_KEY)
    throw new Error(
      'AI analysis is unavailable. You can still record notes, review costs and create variations manually.',
    )
  const client = openai
    ? new OpenAIEstimationClient(openai)
    : new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })
  const model = openai ? ESTIMATION_MODEL : 'claude-sonnet-4-6'
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { response } = await guardedClaudeCall<any>(
    {
      supabase: gatewaySupabase(),
      attribution: { kind: 'builder', builderId: builder },
      callSite: `profitability_${task}`,
      model,
    },
    (signal) =>
      client.messages.create(
        {
          model,
          system,
          max_tokens: 1800,
          tools: [{ name: 'submit_analysis', input_schema: schema as never }],
          tool_choice: { type: 'tool', name: 'submit_analysis' },
          messages: [
            { role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }] } as never,
          ],
        },
        { signal },
      ),
    { timeoutMs: 45000, maxRetries: 0, label: `profitability_${task}` },
  )
  const tool = response.content?.find((c: { type: string }) => c.type === 'tool_use')
  if (!tool?.input || response.stop_reason !== 'tool_use')
    throw new Error('Analysis was incomplete. No financial changes were made.')
  return tool.input
}
