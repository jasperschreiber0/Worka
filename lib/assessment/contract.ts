// ─── Assessment contract ──────────────────────────────────────────────────────
// The typed boundary between orchestration and everything else. Chat and upload
// both build an AssessmentInput and receive an AssessmentResult; the UI switches
// on `stage` and renders `nextAction` / `uiHints` without knowing domain
// internals.

import type { ClassifiedDocument, ScopeReasoning } from '../estimation-reasoning'
import type { GeneratedEstimate } from '../estimate-generation'
import type { StoredQuestion } from '../repositories'

export type AssessmentStage = 'intake' | 'scoping' | 'estimate' | 'handover'

/** Everything that can advance an assessment. Chat + upload both construct one. */
export type AssessmentInput =
  | { kind: 'upload'; fileIds: string[]; jobId: string }
  | { kind: 'chat'; message: string; jobId: string }
  | { kind: 'answer_question'; jobId: string; questionId: string; answer: string }
  | { kind: 'skip_questions'; jobId: string }
  | { kind: 'complete_questions'; jobId: string }
  | { kind: 'generate_estimate'; jobId: string; pricingMode: 'market' | 'user_supplied' }
  | { kind: 'export'; jobId: string; format: 'xlsx' | 'pdf' | 'client'; pricingMode?: 'market' | 'user_supplied' }

export interface RunContext {
  builderId: string
  mode: 'demo' | 'real'
}

export type NextAction =
  | { type: 'answer_questions'; questionCount: number }
  | { type: 'generate_estimate'; pricingModes: Array<'market' | 'user_supplied'> }
  | { type: 'export'; formats: Array<'xlsx' | 'pdf' | 'client'> }
  | { type: 'none' }

/** UI hints intentionally mirror the chat ChatEvent shape so one dispatcher
 *  renders both surfaces. */
export type UiHint =
  | { type: 'open_project_assessment'; jobId: string }
  | { type: 'open_clarifying_questions'; jobId: string }
  | { type: 'open_estimate'; jobId: string }
  | { type: 'download'; url: string; filename: string }

interface AssessmentEnvelope {
  jobId: string
  summary: string
  isIndicative: boolean
  nextAction: NextAction
  uiHints: UiHint[]
  warnings?: Array<{ severity: 'warn' | 'block'; message: string }>
}

export type AssessmentResult =
  | (AssessmentEnvelope & { stage: 'scoping'; data: { documents: ClassifiedDocument[]; scope: ScopeReasoning; questions: StoredQuestion[]; clarificationStatus: string } })
  | (AssessmentEnvelope & { stage: 'estimate'; data: { estimate: GeneratedEstimate } })
  | (AssessmentEnvelope & { stage: 'handover'; data: { formats: Array<'xlsx' | 'pdf' | 'client'> } })
