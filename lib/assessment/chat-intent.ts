// ─── Chat → AssessmentInput translation ───────────────────────────────────────
// Chat must never call the DB/LLM/extraction directly (Layer 1/2 separation).
// This module only recognises whether a message is asking to advance an
// assessment already in progress for a job, and if so which AssessmentInput to
// build. It does not classify general intent — that stays the chat route's job.
// A message only routes here when the caller already has a jobId in play.

import type { AssessmentInput } from './contract'

export function matchAssessmentIntent(message: string, jobId: string): AssessmentInput | null {
  const m = message.toLowerCase().trim()

  if (/\bskip\b.*\b(question|clarif)/.test(m) || /^skip( questions)?$/.test(m)) {
    return { kind: 'skip_questions', jobId }
  }

  if (/\b(generate|build|create|run|do)\b.*\b(estimate|quote|price|pricing)\b/.test(m) || /^price it\b/.test(m)) {
    const pricingMode = /\b(my|our|own)\b.*\brate/.test(m) || /\brate (library|list)\b/.test(m) ? 'user_supplied' : 'market'
    return { kind: 'generate_estimate', jobId, pricingMode }
  }

  if (/\bexport\b.*\b(excel|xlsx|spreadsheet)\b/.test(m)) return { kind: 'export', jobId, format: 'xlsx' }
  if (/\bexport\b.*\b(pdf|builder)\b/.test(m)) return { kind: 'export', jobId, format: 'pdf' }
  if (/\b(client|customer)\b.*\bquot/.test(m)) return { kind: 'export', jobId, format: 'client' }

  return null
}
