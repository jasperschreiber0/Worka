// ─── AssessmentRunner ─────────────────────────────────────────────────────────
// The single orchestration entry point both chat and upload funnel into. It
// routes by input kind — no business logic — delegating to the stage machine,
// which calls services + repositories through injected interfaces. The runner
// never imports Supabase, the Anthropic SDK, React, or next/server.

import type { AssessmentInput, AssessmentResult, RunContext } from './contract'
import { runIntake, resolveQuestions, generateEstimate, fromChat, handover } from './stages'
import { createRepositories, type Repositories } from '../repositories'
import { createServices, type Services } from '../services'
import { createAnthropicLlm, createFakeLlm, type LlmProvider } from '../providers/llm'
import { createSupabaseStorage, type StoragePort } from '../providers/storage'
import type { RenderedExport } from '../services'

/** Injected dependency container — interfaces only, no concrete clients. */
export interface AssessmentDeps {
  repos: Repositories
  services: Services
  storage: StoragePort
  llm: LlmProvider
}

export interface AssessmentRunner {
  /** JSON stages: upload → scoping, question resolution, estimate generation. */
  run(input: AssessmentInput, ctx: RunContext): Promise<AssessmentResult>
  /** Handover: render an export (bytes/HTML) — consumed in-process by the route. */
  render(input: Extract<AssessmentInput, { kind: 'export' }>, ctx: RunContext): Promise<RenderedExport>
}

export function createAssessmentRunner(deps: AssessmentDeps): AssessmentRunner {
  return {
    async run(input, ctx) {
      switch (input.kind) {
        case 'upload':
          return runIntake(input, ctx, deps)
        case 'chat':
          return fromChat(input, ctx, deps)
        case 'answer_question':
        case 'skip_questions':
        case 'complete_questions':
          return resolveQuestions(input, ctx, deps)
        case 'generate_estimate':
          return generateEstimate(input, ctx, deps)
        case 'export':
          throw new Error('Use runner.render() for exports')
      }
    },
    async render(input, ctx) {
      return handover(input, ctx, deps)
    },
  }
}

// ─── Composition root ─────────────────────────────────────────────────────────
// The ONE place concrete adapters are wired. Demo mode uses a fake LLM + no-op
// storage + fixture repos; real mode wires Anthropic + Supabase. Callers only
// ever see the runner interface.

const NOOP_STORAGE: StoragePort = { async load() { return [] } }

export function buildAssessmentRunner(mode: 'demo' | 'real'): AssessmentRunner {
  if (mode === 'demo') {
    const llm = createFakeLlm({})
    return createAssessmentRunner({
      repos: createRepositories('demo'),
      services: createServices('demo', { llm }),
      storage: NOOP_STORAGE,
      llm,
    })
  }

  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured')
  const llm = createAnthropicLlm(apiKey)
  // eslint-disable-next-line @typescript-eslint/no-var-requires, @typescript-eslint/no-explicit-any
  const { createClient } = require('@supabase/supabase-js')
  const supabase = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!)
  return createAssessmentRunner({
    repos: createRepositories('real'),
    services: createServices('real', { llm }),
    storage: createSupabaseStorage(supabase),
    llm,
  })
}
