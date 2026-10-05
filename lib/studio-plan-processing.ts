import {classifyAnthropicError} from '../supabase/functions/smooth-responder/pipeline-logic.ts'

// Both initial reading and a possible geometry correction share this budget.
// Leave time for authentication, accounting and delivery within the 240s route.
export const PLAN_PROCESSING_MS = 210000
export const PLAN_BROWSER_WAIT_MS = 230000
export function planTimeRemaining(started: number, now = Date.now()) {
  return Math.max(0, PLAN_PROCESSING_MS - Math.max(0, now - started))
}
export function planServiceFailure(error: unknown) {
  const classification = classifyAnthropicError(error)
  if (classification === 'client_timeout' || classification === 'application_timeout') {
    return {status:504, code:'plan_timeout', error:'This floor plan took too long to read. Crop the drawing to one floor, keeping its dimensions visible, then try again. Your current model is unchanged.'}
  }
  const unavailable = ['authentication_failed','credit_exhausted'].includes(classification) || (error as any)?.classification === 'budget_refused'
  if (unavailable) return {status:503, code:'plan_service_unavailable', error:'Worka’s plan-reading service is temporarily unavailable. Your plans and current model are unchanged. Please contact Worka support.'}
  return {status:502, code:'plan_service_failed', error:'The plan-reading service could not complete this request. Your current model is unchanged. Please try again later.'}
}
