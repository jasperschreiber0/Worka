// ─── Pure pipeline logic ────────────────────────────────────────────────────
//
// Deliberately dependency-free (no Deno globals, no esm.sh imports, no
// Supabase/Anthropic clients) so this file can be imported both by
// index.ts (Deno, relative import) and by pipeline-logic.test.ts (run with
// `node --experimental-strip-types --test`, since this repo has no test
// framework installed — see CLAUDE.md). Keep it that way: if a function
// here needs a Deno or Supabase API, it belongs in index.ts instead.

// ─── Batch splitting (replaces the old single hard 20MB/6-file cutoff) ────
//
// First-fit-decreasing bin packing: sort largest-first (bigger documents
// are, on average, more fact-rich comprehensive drawing sets — see the
// rationale that used to live inline in index.ts), then place each file
// into the first batch it fits in under the per-batch byte budget, opening
// a new batch when none has room. Bounded by maxBatches so an unreasonably
// large upload still gets a bounded, visible "excluded" list instead of
// unbounded Claude calls — previously anything past the first 6 sibling
// files wasn't even loaded or tracked as skipped, it just vanished.

export interface BatchableFile {
  fileId: string
  filename: string
  approxBytes: number
}

export interface ExcludedFile {
  fileId: string
  filename: string
  reason: string
}

export interface SplitResult {
  batches: BatchableFile[][]
  excluded: ExcludedFile[]
}

export function splitIntoBatches(
  files: BatchableFile[],
  maxBytesPerBatch: number,
  maxBatches: number,
): SplitResult {
  const sorted = [...files].sort((a, b) => b.approxBytes - a.approxBytes)
  const batches: BatchableFile[][] = []
  const excluded: ExcludedFile[] = []

  for (const file of sorted) {
    if (file.approxBytes > maxBytesPerBatch) {
      excluded.push({
        fileId: file.fileId,
        filename: file.filename,
        reason: `exceeds the ${Math.round(maxBytesPerBatch / (1024 * 1024))}MB per-batch analysis limit on its own`,
      })
      continue
    }

    let placed = false
    for (const batch of batches) {
      const batchBytes = batch.reduce((sum, f) => sum + f.approxBytes, 0)
      if (batchBytes + file.approxBytes <= maxBytesPerBatch) {
        batch.push(file)
        placed = true
        break
      }
    }
    if (placed) continue

    if (batches.length >= maxBatches) {
      excluded.push({
        fileId: file.fileId,
        filename: file.filename,
        reason: `batch limit reached (${maxBatches} batches already full — re-upload separately)`,
      })
      continue
    }
    batches.push([file])
  }

  return { batches, excluded }
}

// ─── Fact merge / supersession ─────────────────────────────────────────────
//
// Extracted verbatim from the logic that used to live inline in
// runPipeline (P0 fix from the earlier multi-document reasoning audit):
// a new fact for the same job + category + key with a different value
// supersedes the prior one; otherwise, if both sides have an embedding,
// a near-duplicate (cosine similarity above threshold) is treated as the
// same real-world fact restated under a different label.

export interface FactRow {
  id?: string
  category: string
  key: string
  value: string
  evidence: string | null
  confidence: number
  embedding?: number[] | null
  // Optional: only populated by callers reading full project_facts rows
  // for context-building (e.g. lib/project-context.ts), not required by
  // mergeFacts itself. Kept on the same FactRow type rather than a second,
  // parallel shape so there's exactly one definition of "a project_facts
  // row" shared across the Deno pipeline and the Next.js app — see
  // "Priority 2: Remove implicit storage contracts" in project history.
  source_document_id?: string | null
  superseded?: boolean
  created_at?: string
}

// Above this similarity, two facts are treated as the same real-world fact
// restated (possibly with a different category/key label) rather than two
// distinct facts. This is the ONE definition of "semantic duplicate" for
// this pipeline — used at write time by mergeFacts (below) and reused,
// not reimplemented, at read time by pairSupersededFacts for chat's
// project-memory context (lib/project-context.ts). Previously this lived
// only as a local constant inside smooth-responder/index.ts; chat's
// read-side conflict detection had no access to it and fell back to
// exact category+key matching only, silently missing exactly the class of
// conflict this threshold exists to catch (see mergeFacts's comment).
export const SEMANTIC_DUPLICATE_THRESHOLD = 0.93

// Hard ceiling on how many facts get concatenated into a single prompt —
// shared by Stage 3/6's scope/estimate reasoning (smooth-responder/
// index.ts) and chat's project-memory context (lib/project-context.ts).
// Previously a local constant in index.ts; moved here so both consumers
// truncate identically instead of each guessing their own number.
export const MAX_FACTS_IN_PROMPT = 200

export interface FactMergeResult {
  supersededIds: string[]
  supersededKeys: string[]
  mergedFacts: FactRow[]
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0
  let dot = 0, normA = 0, normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  if (normA === 0 || normB === 0) return 0
  return dot / (Math.sqrt(normA) * Math.sqrt(normB))
}

export function mergeFacts(
  existingFacts: FactRow[],
  newFacts: FactRow[],
  semanticThreshold: number,
): FactMergeResult {
  const priorByKey = new Map(existingFacts.map((f) => [`${f.category}::${f.key}`, f]))
  const supersededIds = new Set<string>()
  const supersededKeys = new Set<string>()

  for (const nf of newFacts) {
    const k = `${nf.category}::${nf.key}`
    const exactMatch = priorByKey.get(k)
    if (exactMatch && String(exactMatch.value).trim().toLowerCase() !== nf.value.trim().toLowerCase()) {
      if (exactMatch.id) supersededIds.add(exactMatch.id)
      supersededKeys.add(k)
      continue
    }

    if (!nf.embedding) continue
    let bestSim = 0
    let bestMatch: FactRow | null = null
    for (const prior of existingFacts) {
      if (!prior.embedding || (prior.id && supersededIds.has(prior.id))) continue
      const sim = cosineSimilarity(nf.embedding, prior.embedding)
      if (sim > bestSim) { bestSim = sim; bestMatch = prior }
    }
    if (bestMatch && bestSim >= semanticThreshold) {
      if (bestMatch.id) supersededIds.add(bestMatch.id)
      supersededKeys.add(`${bestMatch.category}::${bestMatch.key}`)
    }
  }

  const mergedFacts = [
    ...existingFacts.filter((f) => !supersededKeys.has(`${f.category}::${f.key}`)),
    ...newFacts,
  ]

  return {
    supersededIds: Array.from(supersededIds),
    supersededKeys: Array.from(supersededKeys),
    mergedFacts,
  }
}

// ─── Fact selection for a single prompt ────────────────────────────────────
//
// Extracted from what used to be duplicated inline in two places inside
// smooth-responder/index.ts's Stage 3/6 (identical `.sort((a,b) =>
// b.confidence - a.confidence).slice(0, MAX_FACTS_IN_PROMPT)` at both call
// sites) — now the one place this logic exists, called by both the Deno
// pipeline (no relevantCategories — it reasons across every trade, there's
// no single question to be relevant to) and lib/project-context.ts's chat
// answer-building (relevantCategories inferred from the builder's
// question, see inferRelevantCategories below).
//
// IMPORTANT: this must only ever be called with ACTIVE (non-superseded)
// facts. A prior version of the chat-side caller fetched active and
// superseded facts in one query, ORDER BY created_at DESC LIMIT 200,
// *then* split them — meaning superseded rows competed with active rows
// for the same 200-row budget, and an old-but-still-active, high-
// confidence fact could silently fall out of context (recency isn't
// confidence, and the row could be evicted before the split ever
// happened). Callers must query/filter superseded separately (see
// pairSupersededFacts) and give it its own, smaller budget.
export function selectFactsForPrompt(
  facts: FactRow[],
  maxFacts: number = MAX_FACTS_IN_PROMPT,
  relevantCategories?: Set<string>,
): FactRow[] {
  if (facts.length <= maxFacts) return facts
  if (!relevantCategories || relevantCategories.size === 0) {
    return [...facts].sort((a, b) => b.confidence - a.confidence).slice(0, maxFacts)
  }
  // Relevance-boosted ranking, not a hard filter: a fact whose category
  // wasn't inferred as relevant is still eligible, just ranked behind
  // relevant-category facts of equal or lower confidence. This means a
  // keyword-inference miss degrades gracefully (the fact can still make
  // the cut on confidence alone) rather than vanishing outright the way a
  // hard category filter would if the inference guessed wrong.
  return [...facts]
    .sort((a, b) => {
      const relA = relevantCategories.has(a.category) ? 1 : 0
      const relB = relevantCategories.has(b.category) ? 1 : 0
      if (relA !== relB) return relB - relA
      return b.confidence - a.confidence
    })
    .slice(0, maxFacts)
}

// ─── Coarse category relevance inference (no embeddings) ──────────────────
//
// A deliberately simple keyword heuristic, not a retrieval system: it only
// ever RE-RANKS which facts survive truncation (see selectFactsForPrompt
// above) — it never removes a fact outright. This is the right amount of
// engineering for the current fact volume (capped at MAX_FACTS_IN_PROMPT,
// which today's projects rarely exceed): a real embeddings-based retrieval
// layer is justified once truncation starts happening routinely and
// keyword inference's false-negative rate starts mattering, not before.
// Categories mirror the enum smooth-responder's DOCUMENT_INTELLIGENCE_TOOL
// schema constrains Claude's extraction to (index.ts) — kept here instead
// of only there so this stays honest if that enum ever changes.
export const FACT_CATEGORY_KEYWORDS: Record<string, string[]> = {
  finishes: ['floor', 'flooring', 'finish', 'paint', 'tile', 'timber floor', 'carpet', 'polished concrete'],
  fixtures: ['tap', 'tapware', 'fixture', 'window', 'door', 'handle', 'hardware'],
  materials: ['material', 'brick', 'cladding', 'concrete', 'steel', 'render', 'weatherboard'],
  kitchens: ['kitchen', 'cabinetry', 'benchtop', 'splashback', 'pantry'],
  laundries: ['laundry'],
  wet_areas: ['bathroom', 'ensuite', 'toilet', 'shower', 'wet area', 'wc'],
  services: ['electrical', 'plumbing', 'hvac', 'services', 'wiring', 'ducted', 'hydraulic'],
  structural_system: ['structural', 'footing', 'slab', 'frame', 'beam', 'column'],
  external_works: ['landscap', 'driveway', 'fence', 'external', 'deck', 'pergola', 'retaining wall'],
  rooms: ['bedroom', 'living', 'room', 'storey', 'floor plan', 'layout'],
  construction_method: ['construction method', 'build method', 'framing type'],
}

export function inferRelevantCategories(question: string): Set<string> {
  const q = question.toLowerCase()
  const hits = new Set<string>()
  for (const [category, keywords] of Object.entries(FACT_CATEGORY_KEYWORDS)) {
    if (keywords.some((k) => q.includes(k))) hits.add(category)
  }
  return hits
}

// ─── Superseded-fact pairing (read-side conflict/change detection) ────────
//
// mergeFacts (write time, inside smooth-responder) already detects two
// classes of "this is the same real-world fact restated": an exact
// category+key match with a different value, and — when both sides have
// an embedding — a semantic near-duplicate under a different label. A
// prior version of chat's read-side change detection only checked the
// first (exact category+key), which is a strictly weaker guarantee than
// what write time already computed: a fact semantically superseded via
// embedding similarity (e.g. "gross floor area: 120m2" vs floor_area_m2:
// 120) would never be paired with its replacement in chat, even though
// mergeFacts had already correctly marked it superseded. This reuses the
// SAME threshold and similarity function mergeFacts uses, so there is
// exactly one definition of "these two facts are the same thing restated"
// across write time and read time, not two.
export interface FactChange {
  category: string
  key: string
  oldValue: string
  newValue: string
}

export function pairSupersededFacts(
  activeFacts: FactRow[],
  supersededFacts: FactRow[],
  semanticThreshold: number = SEMANTIC_DUPLICATE_THRESHOLD,
  maxChanges: number = 10,
): FactChange[] {
  const activeByKey = new Map(activeFacts.map((f) => [`${f.category}::${f.key}`, f]))
  const changes: FactChange[] = []

  for (const old of supersededFacts) {
    if (changes.length >= maxChanges) break

    const exact = activeByKey.get(`${old.category}::${old.key}`)
    if (exact) {
      changes.push({ category: old.category, key: old.key, oldValue: old.value, newValue: exact.value })
      continue
    }

    if (!old.embedding) continue
    let bestMatch: FactRow | null = null
    let bestSim = 0
    for (const active of activeFacts) {
      if (!active.embedding) continue
      const sim = cosineSimilarity(old.embedding, active.embedding)
      if (sim > bestSim) { bestSim = sim; bestMatch = active }
    }
    if (bestMatch && bestSim >= semanticThreshold) {
      changes.push({ category: bestMatch.category, key: bestMatch.key, oldValue: old.value, newValue: bestMatch.value })
    }
  }

  return changes
}

// ─── Text-extraction gating (per-invocation CPU budget control) ───────────
//
// Supabase Edge Functions cap CPU time at 2000ms PER REQUEST — the whole
// invocation, not per file and not per batch (see Supabase's own CPU-limits
// docs). A production incident showed runPipeline blowing through that
// ceiling while extracting the text layer of the 5th of 7 uploaded PDFs
// ("Kitchen Elevation.pdf", ~290KB raw — nowhere near "large"), logging
// pdf.js's "TT: undefined function" warning (an embedded TrueType font
// program it struggles to interpret) immediately before Supabase killed the
// isolate outright ("CPU Time exceeded"). That kill is external and
// uncatchable — no JS catch/finally runs — which is why the job lock leaked
// until its own staleness timeout, then retried the identical crash forever.
//
// A byte-size cutoff alone cannot explain or prevent this: Kitchen
// Elevation.pdf is small. The real risk is CUMULATIVE — text extraction is
// synchronous, CPU-bound work, and every file's extraction in one run draws
// from the SAME shared 2-second budget alongside everything else the
// invocation does (base64 (de)serialization, Supabase/Anthropic client
// response handling, logging). Four files' worth of extraction, even if
// each is individually unremarkable, can leave too little headroom for a
// fifth. gateTextExtraction is checked before every extraction attempt,
// against both weak per-file heuristics (byte size, page count — kept as a
// floor for genuinely oversized documents, not because they reliably
// predict cost) and a deliberately conservative run-wide budget that the
// caller (index.ts) tracks across the whole invocation. Pure and
// unit-tested for the same reason shouldGiveUp is: no Deno runtime required.

export interface ExtractionLimits {
  maxBytes: number
  maxPages: number
  maxCumulativeMs: number
}

export const DEFAULT_EXTRACTION_LIMITS: ExtractionLimits = {
  maxBytes: 4 * 1024 * 1024,
  maxPages: 15,
  // Well under Supabase's real 2000ms/request CPU ceiling — leaves
  // headroom for everything else the invocation spends the same budget on.
  // Deliberately conservative; tune from the extraction_start/
  // extraction_end structured logs this fix adds once real production
  // durations are available, rather than guessing further.
  maxCumulativeMs: 900,
}

export interface ExtractionGateResult {
  skip: boolean
  reason: string | null
}

export function gateTextExtraction(
  byteLength: number,
  pageCount: number | null,
  cumulativeSpentMs: number,
  limits: ExtractionLimits = DEFAULT_EXTRACTION_LIMITS,
): ExtractionGateResult {
  // Checked first: once the run has already spent its self-imposed budget,
  // no per-file size/page signal matters — nothing else gets attempted.
  if (cumulativeSpentMs >= limits.maxCumulativeMs) {
    return { skip: true, reason: `run-wide extraction budget (${limits.maxCumulativeMs}ms) already spent by earlier files this run` }
  }
  if (byteLength > limits.maxBytes) {
    return { skip: true, reason: `over ${Math.round(limits.maxBytes / (1024 * 1024))}MB raw` }
  }
  if (pageCount !== null && pageCount > limits.maxPages) {
    return { skip: true, reason: `over ${limits.maxPages} pages (${pageCount} pages)` }
  }
  return { skip: false, reason: null }
}

// ─── Timeout decision ──────────────────────────────────────────────────────
//
// Pure wall-clock-since-start was the only signal the Next.js poller used
// to give up (OVERALL_TIMEOUT_MS = 15min) — a run legitimately working
// through several batches and a run that's actually hung look identical to
// it. This adds a second, tighter signal: give up early if no progress
// (stage/pct change) has been observed in stuckTimeoutMs, regardless of
// how much of the overall budget is left — and still enforce the overall
// ceiling regardless of how recently progress ticked, so a run that keeps
// inching forward forever doesn't run unbounded.

export function shouldGiveUp(
  now: number,
  overallStartedAt: number,
  lastProgressAt: number,
  overallTimeoutMs: number,
  stuckTimeoutMs: number,
): boolean {
  if (now - overallStartedAt > overallTimeoutMs) return true
  if (now - lastProgressAt > stuckTimeoutMs) return true
  return false
}

// ─── Document processing queue (worker model) ──────────────────────────────
//
// Text extraction's CPU-budget gating (gateTextExtraction, above) reduces
// the CHANCE any one file blows the shared per-invocation budget, but it
// can't eliminate it — a genuinely pathological document can still exhaust
// its share and take the whole shared invocation down with it, since
// Supabase's CPU-time kill is external and uncatchable regardless of how
// conservative the gating was. The actual fix for blast radius is
// structural: each document gets its OWN document-worker invocation (see
// supabase/functions/document-worker/index.ts), and per Supabase's
// per-REQUEST CPU metering, that's a genuinely fresh 2000ms budget — one
// document's crash can no longer touch any other document's processing.
//
// These are the pure decision functions behind that model — claiming
// (FOR UPDATE SKIP LOCKED) and the transactional "trigger classification
// exactly once" logic live in SQL (migration 034) since they need real
// atomicity a JS pure function can't provide; what's here is everything
// that doesn't need a live database to verify.

export interface DocumentProcessingJobDraft {
  parentJobId: string
  documentId: string
  status: 'pending'
  attempts: number
}

/** One row per document — building the batch's queue entries. */
export function buildDocumentProcessingJobs(parentJobId: string, documentIds: string[]): DocumentProcessingJobDraft[] {
  return documentIds.map((documentId) => ({ parentJobId, documentId, status: 'pending', attempts: 0 }))
}

export const MAX_DOCUMENT_JOB_ATTEMPTS = 3
// Delay before the NEXT attempt, keyed by attempts-so-far after a failure:
// 30s before attempt 2, 2min before attempt 3. Mirrored in migration 034's
// retry_or_fail_document_job — keep both in sync if either changes.
export const RETRY_DELAYS_MS: Record<number, number> = { 1: 30_000, 2: 120_000 }

export interface RetryDecision {
  status: 'pending' | 'failed'
  attempts: number
  delayMs: number | null
}

/**
 * Attempt 1 runs immediately (a freshly-created job's run_after is already
 * "now"). On failure, this decides what happens next: attempts 1 and 2
 * schedule a retry with backoff; the 3rd failure (attempts reaches
 * MAX_DOCUMENT_JOB_ATTEMPTS) marks the document permanently failed.
 */
export function nextRetryState(currentAttempts: number, maxAttempts: number = MAX_DOCUMENT_JOB_ATTEMPTS): RetryDecision {
  const attempts = currentAttempts + 1
  if (attempts >= maxAttempts) {
    return { status: 'failed', attempts, delayMs: null }
  }
  return { status: 'pending', attempts, delayMs: RETRY_DELAYS_MS[attempts] ?? RETRY_DELAYS_MS[2] }
}

export type ChildJobStatus = 'pending' | 'running' | 'completed' | 'failed'
export type ParentBatchStatus = 'pending' | 'running' | 'completed' | 'completed_with_failures' | 'failed'

/**
 * Mirrors recompute_parent_batch_status in migration 034 exactly (kept as
 * a pure function so it's unit-testable without a live database) — the
 * parent batch is only ever 'running' while any child is still
 * pending/running; once every child has reached a terminal state, a mix of
 * completed and failed children is 'completed_with_failures' (a single bad
 * PDF must not fail the whole batch), all-failed is 'failed', and
 * all-completed is 'completed'.
 */
export function deriveParentBatchStatus(childStatuses: ChildJobStatus[]): ParentBatchStatus {
  if (childStatuses.length === 0) return 'pending'
  if (childStatuses.some((s) => s === 'pending' || s === 'running')) return 'running'
  const anyCompleted = childStatuses.some((s) => s === 'completed')
  const anyFailed = childStatuses.some((s) => s === 'failed')
  if (anyFailed && anyCompleted) return 'completed_with_failures'
  if (anyFailed) return 'failed'
  return 'completed'
}
