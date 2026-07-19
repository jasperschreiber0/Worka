// ─── Shared AI gateway — every Anthropic call in WorkA goes through here ─────
//
// Phase 0 of the production-safety plan. One wrapper, imported identically
// from Deno (smooth-responder) and Next.js (the ten route call sites) via the
// same relative-path pattern pipeline-logic.ts already proved out. No call
// site constructs its own retry/spend/logging logic anymore — the gateway
// composes the existing, unchanged withTimeoutAndRetry (timeout + classified
// single retry, untouched) with four new guarantees:
//
//   1. SPEND CEILINGS — before every call: the global circuit breaker
//      (system_status.ai_circuit_breaker) and the per-builder + global daily
//      spend counters (ai_spend_daily vs system_status.ai_limits) are
//      checked. Over-limit or tripped ⇒ AiBudgetError, no call is made.
//      Fails CLOSED: this is the property that makes the incident class
//      "retry loop burns credits overnight" structurally impossible — no
//      matter which bug causes the loop, total damage is bounded by the
//      daily ceiling.
//   2. IDEMPOTENCY (opt-in, pipeline stages only) — callers that pass a
//      scopeKey get exact-replay protection: a prior succeeded ai_operations
//      row with the same scopeKey + input hash short-circuits the call and
//      returns the stored result. This is what stops "Claude succeeded,
//      process crashed before the write, retry pays again" from repeating
//      expensive stage work. Chat/email calls deliberately don't opt in —
//      the same message sent twice is a legitimate new request.
//   3. USAGE LEDGER — every attempt writes an ai_operations row (running →
//      succeeded/failed) with model, tokens, estimated cost, duration, and
//      failure classification, and bumps ai_spend_daily atomically via
//      record_ai_spend (migration 054). Cost visibility is a query, not a
//      guess.
//   4. CRASH EVIDENCE — the 'running' row is written BEFORE the call. A row
//      that never turns terminal is durable proof a call may have been
//      billed without its result landing — the ambiguity the readiness
//      report said must be visible, not silently retried past.
//
// Degradation: with no supabase client (demo mode), DB-backed accounting is
// replaced by a process-local in-memory daily counter with the same limits —
// weaker (per-instance, resets on restart) but never fails open entirely.
// All accounting failures are best-effort in the established codebase sense:
// a failure to RECORD spend never blocks the builder's call — but the
// pre-call LIMIT CHECK failing to read state fails closed for the breaker
// (unknown breaker state ⇒ assume untripped is NOT safe after two spend
// incidents; see checkBudget) while missing spend rows are treated as zero.

import {
  withTimeoutAndRetry,
  type AnthropicFailureClassification,
  type TimedRetryOptions,
} from './pipeline-logic.ts'

// ─── Pricing (cents per million tokens) ──────────────────────────────────────
// Source: Anthropic model pricing at time of writing. Estimated, not billed —
// the point is order-of-magnitude budget enforcement and trend visibility,
// not invoice reconciliation. Unknown models fall back to the most expensive
// known entry so a new model can never silently bypass the budget by being
// priced at zero.
export const AI_PRICING_CENTS_PER_MTOK: Record<string, { input: number; output: number }> = {
  'claude-sonnet-4-6': { input: 300, output: 1500 },
}
const FALLBACK_PRICING = { input: 500, output: 2500 }

export function estimateCostCents(model: string, inputTokens: number, outputTokens: number): number {
  const p = AI_PRICING_CENTS_PER_MTOK[model] ?? FALLBACK_PRICING
  const cents = (inputTokens * p.input + outputTokens * p.output) / 1_000_000
  return Math.round(cents * 100) / 100
}

// ─── Budget decision (pure — unit-tested without a database) ─────────────────

export interface BudgetState {
  breakerTripped: boolean
  breakerReason: string | null
  /** null when the read failed — treated as tripped (fail closed). */
  breakerKnown: boolean
  builderDayCents: number
  globalDayCents: number
  builderLimitCents: number
  globalLimitCents: number
}

export interface BudgetDecision {
  allowed: boolean
  reason: string | null
}

export function decideBudget(state: BudgetState): BudgetDecision {
  if (!state.breakerKnown) {
    return { allowed: false, reason: 'AI circuit breaker state could not be read — failing closed' }
  }
  if (state.breakerTripped) {
    return { allowed: false, reason: `AI circuit breaker is tripped${state.breakerReason ? `: ${state.breakerReason}` : ''}` }
  }
  if (state.globalDayCents >= state.globalLimitCents) {
    return { allowed: false, reason: `Global daily AI spend limit reached (${state.globalDayCents}/${state.globalLimitCents} cents)` }
  }
  if (state.builderDayCents >= state.builderLimitCents) {
    return { allowed: false, reason: `Daily AI processing limit reached for this account (${state.builderDayCents}/${state.builderLimitCents} cents)` }
  }
  return { allowed: true, reason: null }
}

/** Thrown before any Anthropic call when a limit/breaker refuses it. Callers'
 * existing catch paths handle it like any other call failure — with the
 * crucial difference that no money was spent. classification is
 * 'budget_refused' so it is never treated as transient/retryable. */
export class AiBudgetError extends Error {
  readonly classification = 'budget_refused'
  constructor(message: string) {
    super(message)
    this.name = 'AiBudgetError'
  }
}

// ─── Attribution — every call names who it is for, explicitly ────────────────
// No silent nulls: a call is either attributed to a specific builder (the
// normal case — per-builder daily limits apply on top of global ones) or
// explicitly declared a system operation with a stated reason (crons,
// maintenance — global limits only, identifiable in the ledger as such).
// Anything else is a programming error and fails CLOSED before any call.

export type AiAttribution =
  | { kind: 'builder'; builderId: string }
  | { kind: 'system'; reason: string }

/** Thrown before any Anthropic call when attribution is missing/malformed —
 * a code bug surfacing safely (no spend), never a silent unattributed call. */
export class AiAttributionError extends Error {
  readonly classification = 'attribution_invalid'
  constructor(message: string) {
    super(message)
    this.name = 'AiAttributionError'
  }
}

/** Pure, unit-tested. Returns the error message, or null when valid. */
export function validateAttribution(a: AiAttribution | null | undefined): string | null {
  if (!a || typeof a !== 'object') return 'AI call attribution is missing'
  if (a.kind === 'builder') {
    if (typeof a.builderId !== 'string' || a.builderId.trim() === '') {
      return "builder-attributed AI call has no builderId — pass the authenticated builder's id, or declare the call { kind: 'system', reason }"
    }
    return null
  }
  if (a.kind === 'system') {
    if (typeof a.reason !== 'string' || a.reason.trim() === '') {
      return 'system-attributed AI call must state a reason'
    }
    return null
  }
  return `unknown AI attribution kind: ${String((a as { kind?: unknown }).kind)}`
}

// ─── Input hashing (Web Crypto — identical in Deno, Node 18+, edge) ──────────

export async function hashAiInput(parts: unknown[]): Promise<string> {
  const text = JSON.stringify(parts)
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest)).map((b) => b.toString(16).padStart(2, '0')).join('')
}

// ─── In-memory fallback accounting (demo mode / no supabase client) ──────────

const memoryDaily = new Map<string, number>() // key: `${day}:${builderId|global}` → cents

function memoryKey(builderId: string | null): string {
  const day = new Date().toISOString().slice(0, 10)
  return `${day}:${builderId ?? 'global'}`
}

// ─── Minimal structural interface for the Supabase client ────────────────────
// Both @supabase/supabase-js (Next.js) and the esm.sh Deno build satisfy this;
// typing it structurally keeps this module import-free of either SDK.
interface SupabaseLike {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  from(table: string): any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  rpc(fn: string, args?: Record<string, unknown>): PromiseLike<{ data: any; error: any }>
}

// ─── The gateway call ────────────────────────────────────────────────────────

export interface GuardedCallContext {
  /** Service-role client. null in demo mode → in-memory accounting. */
  supabase: SupabaseLike | null
  /** Required, explicit: who this call is for. Builder-attributed calls get
   * per-builder daily limits; system calls are globally limited and
   * identifiable in the ledger. Invalid attribution fails closed. */
  attribution: AiAttribution
  /** Stable label, e.g. 'stage_scope_reasoning', 'chat_extract_actions'. */
  callSite: string
  model: string
  /** Opt-in idempotency: '<job_id>:<stage>'. Omit for chat/email calls. */
  scopeKey?: string
  /** Prompt parts to hash for the idempotency check. Required with scopeKey. */
  inputParts?: unknown[]
}

export interface GuardedCallResult<T> {
  response: T
  /** true when the response was served from a prior succeeded operation —
   * zero Anthropic calls were made. */
  reusedFromOperation: boolean
}

function attributedBuilderId(ctx: GuardedCallContext): string | null {
  return ctx.attribution.kind === 'builder' ? ctx.attribution.builderId : null
}

async function readBudgetState(ctx: GuardedCallContext): Promise<BudgetState> {
  const builderId = attributedBuilderId(ctx)
  if (!ctx.supabase) {
    // Demo mode: process-local counters, same default limits.
    return {
      breakerTripped: false, breakerReason: null, breakerKnown: true,
      builderDayCents: memoryDaily.get(memoryKey(builderId)) ?? 0,
      globalDayCents: memoryDaily.get(memoryKey(null)) ?? 0,
      builderLimitCents: 1000, globalLimitCents: 2500,
    }
  }
  try {
    const [{ data: statusRows }, { data: spendRows }] = await Promise.all([
      ctx.supabase.from('system_status').select('key, value').in('key', ['ai_circuit_breaker', 'ai_limits']),
      ctx.supabase.from('ai_spend_daily')
        .select('builder_id, cost_cents')
        .eq('day', new Date().toISOString().slice(0, 10)),
    ])
    const byKey = new Map((statusRows ?? []).map((r: { key: string; value: unknown }) => [r.key, r.value]))
    const breaker = byKey.get('ai_circuit_breaker') as { tripped?: boolean; reason?: string | null } | undefined
    const limits = byKey.get('ai_limits') as { global_daily_cents?: number; builder_daily_cents?: number } | undefined
    if (!breaker) {
      // The row should always exist (seeded by migration 054). Its absence
      // means the migration hasn't applied or the schema cache is stale —
      // fail closed rather than run unmetered.
      return { breakerTripped: false, breakerReason: null, breakerKnown: false, builderDayCents: 0, globalDayCents: 0, builderLimitCents: 0, globalLimitCents: 0 }
    }
    let builderDay = 0
    let globalDay = 0
    for (const row of (spendRows ?? []) as Array<{ builder_id: string | null; cost_cents: number }>) {
      if (row.builder_id === null) globalDay = Number(row.cost_cents) || 0
      else if (builderId && row.builder_id === builderId) builderDay = Number(row.cost_cents) || 0
    }
    return {
      breakerTripped: breaker.tripped === true,
      breakerReason: breaker.reason ?? null,
      breakerKnown: true,
      builderDayCents: builderDay,
      globalDayCents: globalDay,
      // System-attributed calls have no per-builder ceiling (there is no
      // builder) — the global limit and breaker still fully apply.
      builderLimitCents: builderId === null ? Number.POSITIVE_INFINITY : (Number(limits?.builder_daily_cents) || 1000),
      globalLimitCents: Number(limits?.global_daily_cents) || 2500,
    }
  } catch {
    // Can't read the breaker at all → fail closed (see module header).
    return { breakerTripped: false, breakerReason: null, breakerKnown: false, builderDayCents: 0, globalDayCents: 0, builderLimitCents: 0, globalLimitCents: 0 }
  }
}

/**
 * Route one Anthropic call through the gateway. `call` is the exact same
 * (signal) => anthropic.messages.create(...) closure every call site already
 * passes to withTimeoutAndRetry — retry/timeout semantics are unchanged; the
 * gateway adds budget refusal, idempotent reuse, and the usage ledger around
 * them. Throws AiBudgetError (never retryable, zero spend) on refusal;
 * rethrows the underlying call error unchanged otherwise.
 */
export async function guardedClaudeCall<T>(
  ctx: GuardedCallContext,
  call: (signal: AbortSignal) => Promise<T>,
  options: TimedRetryOptions = {},
): Promise<GuardedCallResult<T>> {
  // 0. Attribution gate — a malformed/missing attribution is a code bug and
  // fails CLOSED here, before the idempotency lookup or any spend: better a
  // loud, safe failure at the call site than a silently unattributed call.
  const attributionProblem = validateAttribution(ctx.attribution)
  if (attributionProblem) {
    console.log(JSON.stringify({ event: 'ai_call_refused', call_site: ctx.callSite, reason: attributionProblem }))
    throw new AiAttributionError(attributionProblem)
  }
  const builderId = attributedBuilderId(ctx)

  // 1. Budget gate — before anything else, including the idempotency lookup?
  // No: reuse first. Serving a stored result costs nothing, so it must work
  // even when the breaker is tripped — that's recovery without spend.
  let inputHash: string | null = null
  if (ctx.scopeKey && ctx.inputParts && ctx.supabase) {
    try {
      inputHash = await hashAiInput(ctx.inputParts)
      const { data: prior } = await ctx.supabase.from('ai_operations')
        .select('id, result')
        .eq('scope_key', ctx.scopeKey)
        .eq('input_hash', inputHash)
        .eq('status', 'succeeded')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle()
      if (prior?.result != null) {
        console.log(JSON.stringify({
          event: 'ai_call_reused', call_site: ctx.callSite, scope_key: ctx.scopeKey,
          operation_id: prior.id,
        }))
        return { response: prior.result as T, reusedFromOperation: true }
      }
    } catch { /* best-effort — a failed lookup just means a normal call */ }
  }

  const budget = await readBudgetState(ctx)
  const decision = decideBudget(budget)
  if (!decision.allowed) {
    console.log(JSON.stringify({
      event: 'ai_call_refused', call_site: ctx.callSite, builder_id: builderId,
      attribution: ctx.attribution.kind, reason: decision.reason,
    }))
    throw new AiBudgetError(decision.reason ?? 'AI budget refused')
  }

  // 2. Crash-evidence row, written before the call.
  let operationId: string | null = null
  if (ctx.supabase) {
    try {
      const { data } = await ctx.supabase.from('ai_operations').insert({
        builder_id: builderId, call_site: ctx.callSite,
        attribution: ctx.attribution.kind,
        attribution_detail: ctx.attribution.kind === 'system' ? ctx.attribution.reason : null,
        scope_key: ctx.scopeKey ?? null, input_hash: inputHash,
        model: ctx.model, status: 'running',
      }).select('id').single()
      operationId = data?.id ?? null
    } catch { /* best-effort — never block the call on ledger failure */ }
  }

  const startedAt = Date.now()
  try {
    const response = await withTimeoutAndRetry(call, options)

    // The SDK's Message shape carries usage/id; typed structurally here so
    // the generic stays unconstrained (a constrained generic collapsed to
    // its constraint under the repo's no-node_modules type-check, masking
    // the real response type at every call site).
    const meta = response as { usage?: { input_tokens?: number; output_tokens?: number }; id?: string } | null
    const inputTokens = meta?.usage?.input_tokens ?? 0
    const outputTokens = meta?.usage?.output_tokens ?? 0
    const costCents = estimateCostCents(ctx.model, inputTokens, outputTokens)
    const durationMs = Date.now() - startedAt

    console.log(JSON.stringify({
      event: 'ai_call_complete', call_site: ctx.callSite, builder_id: builderId,
      attribution: ctx.attribution.kind,
      model: ctx.model, input_tokens: inputTokens, output_tokens: outputTokens,
      cost_cents_estimate: costCents, duration_ms: durationMs,
    }))

    if (ctx.supabase) {
      try {
        if (operationId) {
          await ctx.supabase.from('ai_operations').update({
            status: 'succeeded', completed_at: new Date().toISOString(),
            input_tokens: inputTokens, output_tokens: outputTokens,
            cost_cents: costCents, duration_ms: durationMs,
            request_id: meta?.id ?? null,
            // Store the full response only for idempotency-scoped calls;
            // storing every chat response would duplicate content already
            // persisted elsewhere with no reuse to justify it.
            result: ctx.scopeKey ? (response as unknown as object) : null,
          }).eq('id', operationId)
        }
        await ctx.supabase.rpc('record_ai_spend', {
          p_builder_id: builderId, p_cost_cents: costCents,
        })
      } catch (ledgerErr) {
        console.error('ai-gateway: ledger write failed (call succeeded, accounting incomplete):', ledgerErr)
      }
    } else {
      if (builderId !== null) {
        memoryDaily.set(memoryKey(builderId), (memoryDaily.get(memoryKey(builderId)) ?? 0) + costCents)
      }
      memoryDaily.set(memoryKey(null), (memoryDaily.get(memoryKey(null)) ?? 0) + costCents)
    }

    return { response, reusedFromOperation: false }
  } catch (err) {
    const classification = (err as { classification?: AnthropicFailureClassification })?.classification ?? 'unknown'
    if (ctx.supabase && operationId) {
      try {
        await ctx.supabase.from('ai_operations').update({
          status: 'failed', completed_at: new Date().toISOString(),
          duration_ms: Date.now() - startedAt,
          error_classification: String(classification),
          error_message: (err instanceof Error ? err.message : String(err)).slice(0, 1000),
        }).eq('id', operationId)
      } catch { /* best-effort */ }
    }
    throw err
  }
}
