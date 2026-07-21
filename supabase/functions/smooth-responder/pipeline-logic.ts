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
  /**
   * Indexes into newFacts of exact restatements — same category+key AND the
   * same normalized value as an existing active fact. These are not
   * conflicts (nothing to supersede: the values agree) but inserting them
   * duplicates an established fact, and every duplicate burns a slot of the
   * per-prompt fact budget that a real fact from another document should
   * have had (the same document uploaded twice used to double its own
   * weight this way). Callers should skip inserting these; mergedFacts
   * still includes them unchanged for backward compatibility with callers
   * that only consume supersededIds/Keys.
   */
  duplicateNewFactIndexes: number[]
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
  const duplicateNewFactIndexes: number[] = []

  for (let nfIndex = 0; nfIndex < newFacts.length; nfIndex++) {
    const nf = newFacts[nfIndex]
    const k = `${nf.category}::${nf.key}`
    const exactMatch = priorByKey.get(k)
    if (exactMatch && String(exactMatch.value).trim().toLowerCase() !== nf.value.trim().toLowerCase()) {
      if (exactMatch.id) supersededIds.add(exactMatch.id)
      supersededKeys.add(k)
      continue
    }
    if (exactMatch) {
      // Same key, same value — an exact restatement (e.g. the same document
      // uploaded twice, or two documents agreeing verbatim). Nothing to
      // supersede; flag it so the caller can skip the redundant insert.
      duplicateNewFactIndexes.push(nfIndex)
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
    duplicateNewFactIndexes,
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
// Deterministic tiebreak for facts equal on every ranking criterion above
// it (relevance, then confidence): ascending by `id`. Not semantically
// meaningful — it exists purely so two exactly-tied facts always resolve
// in the same order on every call, regardless of whatever order the
// database happened to return them in for a given query execution.
// Missing ids (a fact not yet persisted) sort last, deterministically.
function idTiebreak(a: FactRow, b: FactRow): number {
  if (a.id === b.id) return 0
  if (a.id === undefined) return 1
  if (b.id === undefined) return -1
  return a.id < b.id ? -1 : 1
}

// ─── Document-balanced fact selection (Stage 3/6) ──────────────────────────
//
// selectFactsForPrompt's global confidence ordering has a failure mode that
// contradicts the product promise outright: when a job's active facts exceed
// the budget, the facts evicted first are the lowest-confidence ones — and
// confidence correlates with document READABILITY, not importance. A scanned
// structural engineering set reads at confidence 40-65; a crisp fixtures
// schedule at 85-95. Past the cap, the global sort deletes the engineering
// document's entire contribution while the builder is told every document
// was processed (verified: 0% survival for a 30-fact scanned document in a
// 300-fact base). Uploading more documents could silently remove earlier
// documents' influence on the estimate.
//
// This selector restores the property the promise depends on — EVERY source
// document is guaranteed representation:
//   1. Group facts by source_document_id (facts with no source — builder
//      answers from the clarify flow — form their own group; they are
//      direct human statements and must never be evicted by volume).
//   2. Reserve floor = max(1, budget / groupCount) slots per group, filled
//      by that group's own highest-confidence facts.
//   3. Spend whatever budget remains on the globally highest-confidence
//      unselected facts — high-value facts still rank higher, exactly as
//      before, just after every document has its guaranteed voice.
// Deterministic throughout (confidence desc, then ascending id — same
// tiebreak contract as selectFactsForPrompt).
//
// Chat's project-memory context deliberately still uses selectFactsForPrompt
// with relevance hints — a single question benefits from relevance ranking;
// a full-project takeoff benefits from full-project representation.

export function selectFactsBalancedBySource(
  facts: FactRow[],
  maxFacts: number = MAX_FACTS_IN_PROMPT,
): FactRow[] {
  if (facts.length <= maxFacts) return facts

  const groups = new Map<string, FactRow[]>()
  for (const f of facts) {
    const key = f.source_document_id ?? '__no_source__'
    const g = groups.get(key)
    if (g) g.push(f)
    else groups.set(key, [f])
  }
  for (const g of Array.from(groups.values())) {
    g.sort((a, b) => b.confidence - a.confidence || idTiebreak(a, b))
  }

  const selected = new Set<FactRow>()

  // Deterministic group order (each group's best fact decides; id breaks
  // ties) — matters only in the degenerate case where there are more source
  // documents than budget slots and even a floor of 1 can't cover them all.
  const orderedGroups = Array.from(groups.values()).sort(
    (a, b) => b[0].confidence - a[0].confidence || idTiebreak(a[0], b[0])
  )

  const floor = Math.max(1, Math.floor(maxFacts / orderedGroups.length))
  for (const g of orderedGroups) {
    if (selected.size >= maxFacts) break
    for (const f of g.slice(0, Math.min(floor, maxFacts - selected.size))) {
      selected.add(f)
    }
  }

  if (selected.size < maxFacts) {
    const remainder = facts
      .filter((f) => !selected.has(f))
      .sort((a, b) => b.confidence - a.confidence || idTiebreak(a, b))
    for (const f of remainder) {
      if (selected.size >= maxFacts) break
      selected.add(f)
    }
  }

  return Array.from(selected).sort((a, b) => b.confidence - a.confidence || idTiebreak(a, b))
}

/** Per-source accounting of a selection — extracted vs actually sent. */
export interface SourceSelectionSummary {
  source_document_id: string | null
  facts_extracted: number
  facts_used: number
}

export function summarizeFactSelection(allFacts: FactRow[], selectedFacts: FactRow[]): SourceSelectionSummary[] {
  const selectedSet = new Set(selectedFacts)
  const bySource = new Map<string | null, { extracted: number; used: number }>()
  for (const f of allFacts) {
    const key = f.source_document_id ?? null
    const entry = bySource.get(key) ?? { extracted: 0, used: 0 }
    entry.extracted++
    if (selectedSet.has(f)) entry.used++
    bySource.set(key, entry)
  }
  return Array.from(bySource.entries())
    .map(([source_document_id, counts]) => ({ source_document_id, facts_extracted: counts.extracted, facts_used: counts.used }))
    .sort((a, b) => (a.source_document_id ?? '').localeCompare(b.source_document_id ?? ''))
}

export function selectFactsForPrompt(
  facts: FactRow[],
  maxFacts: number = MAX_FACTS_IN_PROMPT,
  relevantCategories?: Set<string>,
): FactRow[] {
  if (facts.length <= maxFacts) return facts
  if (!relevantCategories || relevantCategories.size === 0) {
    return [...facts]
      .sort((a, b) => b.confidence - a.confidence || idTiebreak(a, b))
      .slice(0, maxFacts)
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
      return b.confidence - a.confidence || idTiebreak(a, b)
    })
    .slice(0, maxFacts)
}

// Cheap way to answer "did relevance actually change what got selected,
// or just cosmetically reorder it" — compares the SET of fact ids/keys a
// plain confidence-only selection would have produced against what the
// relevance-boosted selection actually produced. Used for observability
// (see lib/project-context.ts) rather than for any selection decision
// itself — selectFactsForPrompt remains the only place that decides what
// gets included.
export function didRelevanceChangeSelection(
  withRelevance: FactRow[],
  withoutRelevance: FactRow[],
): boolean {
  const key = (f: FactRow) => f.id ?? `${f.category}::${f.key}`
  const a = new Set(withRelevance.map(key))
  const b = new Set(withoutRelevance.map(key))
  if (a.size !== b.size) return true
  // Never iterate a Set directly with for...of — the project's TS target
  // doesn't enable --downlevelIteration (see CLAUDE.md's TypeScript
  // Compatibility Rules). Array.from() first, as everywhere else in this
  // codebase.
  return Array.from(a).some((k) => !b.has(k))
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
//
// Known schema limitation (documented, not fixed here — project_facts has
// no superseded_by_id column, so there is no way to reconstruct which
// specific fact superseded which): a fact revised twice (v1 -> v2 -> v3,
// only v3 active) has TWO superseded rows — v1 and v2 — that both match
// the same active replacement (v3) by category+key. Pairing both would
// produce two redundant "changes" entries both claiming v3 as the new
// value, when only one meaningful transition (the most recent
// predecessor -> current) is useful to show. This function collapses
// that: once a given active fact has been paired with one predecessor,
// later (older) predecessors matching the SAME active fact are skipped.
// "Most recent predecessor" is derived from iteration order, NOT a
// timestamp comparison inside this function — callers MUST pass
// supersededFacts ordered most-recently-superseded first (project-context.ts
// already queries `ORDER BY created_at DESC` for exactly this reason). This
// is a real precondition, not an implementation detail: passing an
// unordered or oldest-first array silently changes which predecessor gets
// shown, with no error. What's NOT recoverable without a schema change:
// the full v1->v2->v3 lineage — v1 is dropped from output entirely, not
// merely deprioritized, since nothing in the data says v1 and v2 are part
// of the same lineage rather than two independent corrections.
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
  // Tracks which ACTIVE fact (by category::key) already has a predecessor
  // paired to it — see the multi-generation-chain comment above.
  const pairedTargets = new Set<string>()

  for (const old of supersededFacts) {
    if (changes.length >= maxChanges) break

    const exactKey = `${old.category}::${old.key}`
    const exact = activeByKey.get(exactKey)
    if (exact) {
      if (pairedTargets.has(exactKey)) continue
      pairedTargets.add(exactKey)
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
      const targetKey = `${bestMatch.category}::${bestMatch.key}`
      if (pairedTargets.has(targetKey)) continue
      pairedTargets.add(targetKey)
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

// ─── Document-phase progress (pre-classification) ──────────────────────────
//
// While document-worker invocations are draining a batch, nothing writes
// files.intake_stage/intake_pct at all — classification (Stage 1/2) is what
// owns those columns, and it hasn't started yet. The SSE poller therefore
// used to sit on its initial "Uploading documents... 5%" for the ENTIRE
// extraction phase — minutes of real, observable work (per-document rows
// flipping pending→running→completed) presented to the builder as a frozen
// upload. That's not just cosmetic: "stuck at 5% uploading" is exactly what
// a genuinely-dead run looks like, so builders (reasonably) treated healthy
// runs as hung. This derives an honest stage/pct from the per-document job
// counts the poller already fetches every iteration. The 5→20% band hands
// off to classification's real first write (classifying_documents, 25%)
// without ever moving backwards.

export function documentPhaseProgress(
  terminalCount: number,
  totalCount: number,
): { pct: number; message: string } {
  if (totalCount <= 0) {
    return { pct: 5, message: 'Reading documents...' }
  }
  const done = Math.max(0, Math.min(terminalCount, totalCount))
  const pct = 5 + Math.round((done / totalCount) * 15)
  const message = totalCount === 1
    ? 'Reading your document...'
    : `Reading documents — ${done} of ${totalCount} processed`
  return { pct, message }
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

// ─── Anthropic failure classification ──────────────────────────────────────
//
// Root-cause fix for a production incident: the previous retry logic
// treated every abort (including OUR OWN 150s timeout firing) as
// automatically retryable. Evidence from production logs showed the actual
// failure mode this caused: a 6-document batch's Claude call aborted at
// ~150000ms, was immediately retried with the IDENTICAL payload, and the
// retry aborted at ~150000ms again — because a batch that genuinely needs
// more than 150s of reasoning needs it every time it's sent unchanged, so
// "retry the same request" was guaranteed to burn a second full-price call
// for zero chance of success. Separately, when Anthropic returned
// `400 Your credit balance is too low`, the pipeline logged it but kept
// making MORE calls (next batch, next stage) instead of recognising it as a
// signal to stop spending immediately — and because nothing distinguished
// "this exact failure has already happened before" from "first time seeing
// this," any later re-trigger (a resumed run, a recovery-cron reclaim, a
// manual re-upload) reproduced the identical doomed call again, unbounded.
//
// This section replaces "retry anything that looks transient" with an
// explicit classification of every failure into one of a fixed set of
// categories, each with an explicit, documented retry decision — see
// isRetryableClassification and isBillingHaltClassification below. Nothing
// here guesses; every category maps to a concrete signal (HTTP status,
// Anthropic's own `error.type`, or message content Anthropic's docs specify
// for that condition).

export type AnthropicFailureClassification =
  | 'client_timeout'           // abort fired well before our own deadline — a client/transport-level timeout, not ours
  | 'application_timeout'      // OUR AbortController fired at (or within ~2s of) the configured timeoutMs — see withTimeoutAndRetry
  | 'network_interruption'     // no HTTP response at all (DNS, connection reset, TLS failure) — genuinely transient
  | 'rate_limited'             // 429 / rate_limit_error
  | 'overloaded'               // 5xx / overloaded_error / api_error — Anthropic's own infrastructure, transient
  | 'invalid_request'          // 400 / invalid_request_error, not otherwise classified below
  | 'authentication_failed'    // 401/403 / authentication_error / permission_error — a billing/config problem, not a content problem
  | 'credit_exhausted'         // 400 whose message identifies an insufficient-credit-balance condition
  | 'context_window_exceeded'  // 400 whose message identifies the request as too large for the model's context window
  | 'validation_error'         // 422 / validation_error — Anthropic accepted the request but rejected the tool/schema shape
  | 'unknown'                  // anything not matched above — deliberately NOT auto-retried; see isRetryableClassification

interface AnthropicLikeError {
  name?: string
  message?: string
  status?: number
  error?: { type?: string; message?: string; error?: { type?: string; message?: string } }
}

/**
 * Classifies any error thrown by an Anthropic SDK call (or the
 * AbortController wrapping it) into exactly one AnthropicFailureClassification.
 * `elapsedMs`/`timeoutMs`, when supplied, distinguish OUR deliberate timeout
 * (application_timeout — the abort landed at the deadline we configured)
 * from an abort that fired for some other reason well before that deadline
 * (client_timeout) — both are non-retryable (see isRetryableClassification),
 * but the distinction matters for diagnosing which one actually happened.
 */
export function classifyAnthropicError(
  err: unknown,
  elapsedMs?: number,
  timeoutMs?: number,
): AnthropicFailureClassification {
  const e = (err ?? {}) as AnthropicLikeError
  const message = (e.message ?? (err == null ? '' : String(err))).toLowerCase()
  const isAbort = e.name === 'AbortError' || /\baborted\b/i.test(message)

  if (isAbort) {
    if (typeof elapsedMs === 'number' && typeof timeoutMs === 'number' && elapsedMs >= timeoutMs - 2000) {
      return 'application_timeout'
    }
    return 'client_timeout'
  }

  const status = e.status
  const anthropicErrorType = e.error?.error?.type ?? e.error?.type

  // No HTTP status at all is the shape a raw fetch failure takes (DNS
  // failure, connection reset, TLS handshake failure) — the SDK never got a
  // response to classify by status code.
  if (typeof status !== 'number' && (e.name === 'TypeError' || /network|fetch failed|econnreset|enotfound|eai_again/i.test(message))) {
    return 'network_interruption'
  }

  if (status === 429 || anthropicErrorType === 'rate_limit_error') return 'rate_limited'
  if (anthropicErrorType === 'overloaded_error' || (typeof status === 'number' && status >= 500)) return 'overloaded'
  if (status === 401 || status === 403 || anthropicErrorType === 'authentication_error' || anthropicErrorType === 'permission_error') {
    return 'authentication_failed'
  }
  if (anthropicErrorType === 'validation_error' || status === 422) return 'validation_error'

  if (status === 400 || anthropicErrorType === 'invalid_request_error') {
    if (/credit balance|insufficient.{0,20}credit|billing/i.test(message)) return 'credit_exhausted'
    if (/context length|too many tokens|maximum context|prompt is too long|exceeds the (?:maximum|model's maximum)/i.test(message)) {
      return 'context_window_exceeded'
    }
    return 'invalid_request'
  }

  return 'unknown'
}

// Only these three classifications have a realistic chance of succeeding on
// an unmodified retry — each is either Anthropic explicitly asking the
// caller to back off (rate_limited), Anthropic's own infrastructure having a
// transient problem (overloaded), or the request never reaching Anthropic at
// all (network_interruption). Every other classification is either a
// deterministic property of the request itself (it will fail identically
// every time until the request changes) or a billing/auth problem no retry
// can fix — see isBillingHaltClassification.
const RETRYABLE_CLASSIFICATIONS = new Set<AnthropicFailureClassification>([
  'network_interruption', 'rate_limited', 'overloaded',
])

export function isRetryableClassification(classification: AnthropicFailureClassification): boolean {
  return RETRYABLE_CLASSIFICATIONS.has(classification)
}

/** True for errors worth retrying — thin wrapper over classifyAnthropicError, kept for callers with no elapsed/timeout to report. */
export function isRetryableApiError(err: unknown): boolean {
  return isRetryableClassification(classifyAnthropicError(err))
}

// These two classifications mean the ANTHROPIC ACCOUNT, not this one
// request, cannot proceed — every other in-flight or subsequent call in the
// same processing run will fail identically until a human fixes billing/
// auth. Callers MUST treat this as "stop calling Anthropic for the rest of
// this run" (see haltForBilling in index.ts), not just "this call failed."
const BILLING_HALT_CLASSIFICATIONS = new Set<AnthropicFailureClassification>([
  'credit_exhausted', 'authentication_failed',
])

export function isBillingHaltClassification(classification: AnthropicFailureClassification): boolean {
  return BILLING_HALT_CLASSIFICATIONS.has(classification)
}

// Classifications where the failure is deterministic for the REQUEST'S
// SIZE, not the request's content — a genuinely smaller retry (a solo
// batch instead of a group — see forcedSoloInput in index.ts) has a real
// chance of succeeding, unlike resending the identical payload. Distinct
// from RETRYABLE_CLASSIFICATIONS (the single in-call retry decision in
// withTimeoutAndRetry): an application_timeout must NOT be retried a
// second time with the SAME payload inside one call (that's the double-
// 150s-timeout production bug this whole redesign fixes — see
// withTimeoutAndRetry's own comment), but IS worth exactly one attempt
// with a genuinely smaller payload on a LATER invocation. Production
// readiness review finding: the original version of shouldStopRetrying
// conflated these two questions — by testing `!isRetryableClassification`
// alone, it stopped an application_timeout/context_window_exceeded file
// on its very FIRST occurrence, making the solo-retry path
// (splitBatchForRetry / forcedSoloInput) unreachable for exactly the
// classification the original incident exhibited. This set exists so that
// question is answered independently of the single-call retry question.
const ONE_MORE_ATTEMPT_CLASSIFICATIONS = new Set<AnthropicFailureClassification>([
  'application_timeout', 'context_window_exceeded',
])

/**
 * How many consecutive occurrences of this classification are tolerated
 * before shouldStopRetrying gives up, mirrored exactly by the atomic SQL
 * function record_ai_failure (migration 043) — keep both in sync if either
 * changes.
 *
 * - 0 (credit_exhausted, authentication_failed, invalid_request,
 *   validation_error, unknown, client_timeout): never worth even one
 *   cross-invocation retry — either it's a billing/auth problem no retry
 *   fixes (and never reaches this function in practice — see
 *   isBillingHaltClassification/haltForBilling, which halts the run
 *   before recordAiFailure is ever called for these two), or it's a
 *   deterministic property of the request's CONTENT that a resend
 *   (identical or solo) can't change.
 * - 1 (application_timeout, context_window_exceeded): the request's SIZE
 *   is implicated, not its content — worth exactly one more attempt at a
 *   genuinely smaller size. Each occurrence here already represents
 *   exactly one real Claude call (these are excluded from
 *   RETRYABLE_CLASSIFICATIONS, so withTimeoutAndRetry never retries them
 *   in-call) — so "1" means "stop after the SECOND identical occurrence",
 *   matching the incident's own evidence (batch fails once, solo retry
 *   fails identically a second time, THEN give up).
 * - 2 (network_interruption, rate_limited, overloaded): each occurrence
 *   here already represents TWO real Claude calls (the initial attempt
 *   plus withTimeoutAndRetry's one in-call retry, since these ARE in
 *   RETRYABLE_CLASSIFICATIONS) — kept at 2 to preserve the existing,
 *   already-correct tolerance for genuinely transient infrastructure
 *   blips, unrelated to either blocking issue this constant was
 *   introduced to fix.
 */
export function maxConsecutiveOccurrences(classification: AnthropicFailureClassification): number {
  if (ONE_MORE_ATTEMPT_CLASSIFICATIONS.has(classification)) return 1
  if (isRetryableClassification(classification)) return 2
  return 0
}

/**
 * Cross-attempt guard: even a classification worth retrying at all must
 * stop once it's recurred past its maxConsecutiveOccurrences allowance —
 * a repeat of the identical classification is treated as proof the
 * failure is deterministic for this input, not bad luck, matches
 * document_processing_jobs' own "give up after repeated identical
 * failure" posture (migration 034), applied here to the AI-call axis
 * rather than the extraction axis.
 */
export function shouldStopRetrying(
  priorClassification: AnthropicFailureClassification | null,
  priorConsecutiveFailures: number,
  currentClassification: AnthropicFailureClassification,
): boolean {
  const max = maxConsecutiveOccurrences(currentClassification)
  if (max <= 0) return true
  return priorClassification === currentClassification && priorConsecutiveFailures >= max
}

/**
 * Pure state transition for the persisted per-file failure history
 * (files.ai_failure_classification / files.ai_failure_count — migration
 * 042): a repeat of the same classification increments the streak, any
 * other classification resets it to a fresh streak of 1. Kept as a pure
 * function so the "twice with the same classification" rule in
 * shouldStopRetrying is testable without a live database.
 */
export function nextFailureHistory(
  prior: { classification: AnthropicFailureClassification | null; count: number },
  current: AnthropicFailureClassification,
): { classification: AnthropicFailureClassification; count: number } {
  return prior.classification === current
    ? { classification: current, count: prior.count + 1 }
    : { classification: current, count: 1 }
}

/**
 * Splits a batch of files in half for a smaller retry, rather than resending
 * the identical oversized request that just timed out / exceeded the
 * context window. Returns null once the batch is already down to one file —
 * there's nothing left to split, so the caller must give up on that file
 * (recording the failure via nextFailureHistory) instead of looping.
 */
export function splitBatchForRetry<T>(batch: T[]): [T[], T[]] | null {
  if (batch.length <= 1) return null
  const mid = Math.ceil(batch.length / 2)
  return [batch.slice(0, mid), batch.slice(mid)]
}

// A page-chunked PDF (pdf-chunk.ts) produces several batch entries sharing
// one real `files` row, each id suffixed `${realId}#pStart-End`. Production
// readiness review finding: recording a failure once per CHUNK for a batch
// that failed as a single Claude call inflated a single real failure into
// 2+ counted occurrences — a large chunked document could exhaust
// maxConsecutiveOccurrences after only ONE actual failed attempt, exactly
// the document profile (large multi-page PDFs) the solo-retry path exists
// to protect. Strips the chunk suffix and de-duplicates so one Claude-call
// failure is recorded as exactly one occurrence per real underlying file,
// regardless of how many chunks of it were bundled into the failed batch.
export function dedupeRealFileIds(fileIds: string[]): string[] {
  return Array.from(new Set(fileIds.map((id) => id.split('#')[0])))
}

// ─── Stage 3 (Scope Reasoning) reliability ─────────────────────────────────
//
// Root cause (production incident, see CLAUDE.md "Anthropic failure
// classification" section and the follow-up investigation): Stage 3 reasons
// over the WHOLE accumulated project_facts base in one call, with (a) each
// fact's `evidence` string injected into the prompt completely unbounded,
// and (b) all ≤13 trades reasoned about — and their full included_scope/
// excluded_scope/dependencies/assumptions/uncertainty_notes generated — in a
// single call. Both drive the call toward its wall-clock timeout as a
// project's fact base grows, and unlike Stage 1/2 there was previously no
// lever to make a retry's request genuinely smaller.

// Cap on how many characters of a fact's evidence string are injected into
// the Stage 3 prompt. Deliberately mid-range of the 200-300 char window: the
// reasoning stage needs "what supports this quantity" context, not the full
// extracted excerpt — the untruncated evidence remains intact in
// project_facts (this only bounds what's copied INTO one prompt).
export const STAGE3_MAX_EVIDENCE_CHARS = 240

// Renders one project_facts row as a single Stage 3 prompt line, in the
// exact format the prompt has always used, with evidence capped. Pure and
// independently testable so "an arbitrarily long evidence string cannot
// blow out the prompt" is provable without constructing a real Claude call.
export function truncateEvidence(evidence: string | null, maxChars: number = STAGE3_MAX_EVIDENCE_CHARS): string | null {
  if (evidence === null) return null
  if (evidence.length <= maxChars) return evidence
  return `${evidence.slice(0, maxChars)}…`
}

export function formatFactForScopePrompt(fact: FactRow, maxEvidenceChars: number = STAGE3_MAX_EVIDENCE_CHARS): string {
  const evidence = truncateEvidence(fact.evidence, maxEvidenceChars)
  return `- [${fact.category}] ${fact.key}: ${fact.value} (confidence ${fact.confidence}%${evidence ? `, evidence: ${evidence}` : ''})`
}

// ── Trade chunking ──────────────────────────────────────────────────────
//
// Above this many facts in the prompt, Stage 3 is split into multiple
// smaller calls, each reasoning about only a subset of the 13 trade
// categories — bounding output generation (the other confirmed cost driver
// alongside prompt size) per call, without touching MAX_FACTS_IN_PROMPT or
// requiring a second, filtered fact set per chunk (every chunk still sees
// the full, evidence-capped fact block — cross-trade context, e.g. "the
// slab note affects both Site Works and Framing," is preserved in every
// call; only the set of trades a given call is asked to REASON ABOUT
// shrinks). Deliberately a plain top-level threshold, not tied to any
// specific project's failure history — this is a proactive complexity
// signal, independent of whether this exact project has failed before.
export const STAGE3_TRADE_CHUNK_FACT_THRESHOLD = 100

// Default number of chunks once the threshold is exceeded — matches the
// investigation's recommendation (split into two groups) rather than
// scaling chunk count continuously with fact count, which would need real
// production timing data to tune safely.
export const STAGE3_DEFAULT_CHUNK_COUNT = 2

export function shouldChunkTradeReasoning(
  factsInPromptCount: number,
  threshold: number = STAGE3_TRADE_CHUNK_FACT_THRESHOLD,
): boolean {
  return factsInPromptCount > threshold
}

// Deterministic, order-preserving split into `chunkCount` contiguous,
// near-equal-size groups. Pure and generic (not hardcoded to the 13 trade
// categories) so it's testable against any list shape; the one real caller
// passes TRADE_CATEGORIES. A chunkCount of 1 (or >= the list length)
// degrades to the identity split, never an empty group swallowing a trade.
export function splitTradeCategoriesIntoChunks<T>(items: T[], chunkCount: number): T[][] {
  const count = Math.max(1, Math.min(chunkCount, items.length))
  const chunkSize = Math.ceil(items.length / count)
  const chunks: T[][] = []
  for (let i = 0; i < items.length; i += chunkSize) {
    chunks.push(items.slice(i, i + chunkSize))
  }
  return chunks
}

// Proven-safe ceiling for one Stage 3 call, unchanged from the original
// 150s->220s widening (see index.ts's own comment on that call site).
// Never inflated beyond this even when budget is tight -- the whole point
// of chunking is bounding a single call's size, so a request that grows
// because budget was short would reintroduce the exact timeout risk
// chunking exists to remove.
export const STAGE3_PER_CALL_TIMEOUT_MS = 220_000

export interface Stage3ChunkPlan<T> {
  // Chunks safe to actually attempt in THIS invocation, sized at the
  // proven-safe STAGE3_DEFAULT_CHUNK_COUNT split (or fewer chunks if the
  // remaining trade list is small) -- never inflated to fit more trades
  // into one call just because budget allowed it.
  chunksToRunNow: T[][]
  // True when the full trade list needed more chunks than fit in the
  // available budget -- some trades are deliberately left for a LATER
  // invocation (a fresh wall-clock window) rather than crammed into an
  // oversized call now.
  hasMoreAfterThisInvocation: boolean
}

// Budget-aware Stage 3 chunk planning: decides how many of the (already
// right-sized) chunks can actually be attempted THIS invocation without
// starting a call that cannot finish inside the remaining wall-clock
// window. This is the core of the redesign that replaces the old
// "hasWallClockBudget(220_000 * fixedChunkCount) or bail entirely" check
// (which either ran the full fixed plan or made zero progress) with
// "run as many right-sized chunks as genuinely fit, persist that
// progress, and leave the rest for the next invocation."
//
// remainingTrades should already exclude any trade whose scope reasoning
// was durably completed in a PRIOR invocation of this same batch (see
// document_processing_batches.stage3_completed_trade_ids, migration 060)
// -- this function only decides how much of what's LEFT fits now.
export function planStage3Chunks<T>(
  remainingTrades: T[],
  remainingBudgetMs: number,
  factsInPromptCount: number,
  chunkThreshold: number = STAGE3_TRADE_CHUNK_FACT_THRESHOLD,
  desiredChunkCount: number = STAGE3_DEFAULT_CHUNK_COUNT,
): Stage3ChunkPlan<T> {
  if (remainingTrades.length === 0) {
    return { chunksToRunNow: [], hasMoreAfterThisInvocation: false }
  }

  const maxAffordableCalls = Math.floor(remainingBudgetMs / STAGE3_PER_CALL_TIMEOUT_MS)
  if (maxAffordableCalls < 1) {
    // Cannot safely start even one call this invocation -- never attempt
    // a call that can't finish inside the remaining window. All of
    // remainingTrades is deferred, untouched, to the next invocation.
    return { chunksToRunNow: [], hasMoreAfterThisInvocation: true }
  }

  const desiredGroups = shouldChunkTradeReasoning(factsInPromptCount, chunkThreshold) ? desiredChunkCount : 1
  const fullPlan = splitTradeCategoriesIntoChunks(remainingTrades, desiredGroups)
  const chunksToRunNow = fullPlan.slice(0, maxAffordableCalls)
  const hasMoreAfterThisInvocation = fullPlan.length > chunksToRunNow.length

  return { chunksToRunNow, hasMoreAfterThisInvocation }
}

export interface ScopeReasoningResult {
  scope: Array<Record<string, unknown>>
  clarifying_questions: Array<Record<string, unknown>>
}

export interface MergedScopeReasoningResult extends ScopeReasoningResult {
  // trade_category_ids where more than one chunk returned an entry — should
  // be empty in the normal case (chunks are given disjoint trade subsets),
  // present only if a chunk didn't fully respect its assigned trades. The
  // caller logs this for observability; it is never itself an error.
  tradeCollisions: unknown[]
}

const MERGE_CONFLICT_NOTE_PREFIX =
  '[merge conflict: multiple chunked Stage 3 calls returned different scope for this trade — both preserved below, review recommended]'

function unionStrings(a: unknown, b: unknown): string[] {
  const arrA = Array.isArray(a) ? (a as string[]) : []
  const arrB = Array.isArray(b) ? (b as string[]) : []
  return Array.from(new Set([...arrA, ...arrB]))
}

// Combines two scope entries for the SAME trade_category_id into one,
// preserving both sides rather than picking a winner — audit finding: a
// prior version silently discarded whichever chunk's entry arrived first
// (last-writer-wins), which could drop a genuine disagreement (e.g. "timber
// frame" vs "steel portal frame" for the same trade) with zero trace. Every
// array field is unioned (deduplicated, so an identical item both chunks
// agree on isn't doubled); uncertainty_notes is prefixed with an explicit
// conflict marker and both original notes appended, so the disagreement
// itself is visible rather than silently resolved one way; confidence
// takes the more conservative (lower) of the two, since a collision is
// itself evidence the answer is less certain than either chunk alone
// reported.
export function mergeConflictingScopeEntries(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  const existingNotes = typeof existing.uncertainty_notes === 'string' ? existing.uncertainty_notes : null
  const incomingNotes = typeof incoming.uncertainty_notes === 'string' ? incoming.uncertainty_notes : null
  const combinedNotes = [existingNotes, incomingNotes].filter((n): n is string => Boolean(n)).join(' | ')
  const existingConfidence = typeof existing.confidence === 'number' ? existing.confidence : 100
  const incomingConfidence = typeof incoming.confidence === 'number' ? incoming.confidence : 100

  return {
    trade_category_id: existing.trade_category_id,
    included_scope: unionStrings(existing.included_scope, incoming.included_scope),
    excluded_scope: unionStrings(existing.excluded_scope, incoming.excluded_scope),
    dependencies: unionStrings(existing.dependencies, incoming.dependencies),
    assumptions: unionStrings(existing.assumptions, incoming.assumptions),
    uncertainty_notes: combinedNotes ? `${MERGE_CONFLICT_NOTE_PREFIX} ${combinedNotes}` : MERGE_CONFLICT_NOTE_PREFIX,
    confidence: Math.min(existingConfidence, incomingConfidence),
  }
}

// Deterministic merge of one or more chunked Stage 3 results back into the
// single shape the rest of the pipeline (scope_items upsert, clarifying_
// questions insert, Stage 6) already expects — no downstream code needs to
// know chunking happened. scope rows are keyed by trade_category_id;
// chunks are given disjoint trade subsets so a collision should be rare,
// but when one occurs the two entries are merged (mergeConflictingScopeEntries)
// rather than one silently overwriting the other. clarifying_questions are
// deduplicated by exact (question, trade_category_id) text match, since a
// general, non-trade-specific gap (trade_category_id null) could plausibly
// be raised independently by more than one chunk with identical wording —
// a different wording of the same real gap is NOT deduplicated (deliberately:
// fuzzy text matching risks discarding a genuinely distinct concern, worse
// than an occasional duplicate reaching the builder).
export function mergeScopeReasoningResults(chunks: ScopeReasoningResult[]): MergedScopeReasoningResult {
  const scopeByTrade = new Map<unknown, Record<string, unknown>>()
  const tradeCollisions: unknown[] = []
  for (const chunk of chunks) {
    for (const row of chunk.scope ?? []) {
      const existing = scopeByTrade.get(row.trade_category_id)
      if (existing) {
        tradeCollisions.push(row.trade_category_id)
        scopeByTrade.set(row.trade_category_id, mergeConflictingScopeEntries(existing, row))
      } else {
        scopeByTrade.set(row.trade_category_id, row)
      }
    }
  }

  const seenQuestions = new Set<string>()
  const questions: Array<Record<string, unknown>> = []
  for (const chunk of chunks) {
    for (const q of chunk.clarifying_questions ?? []) {
      const key = `${q.question} ${q.trade_category_id ?? ''}`
      if (seenQuestions.has(key)) continue
      seenQuestions.add(key)
      questions.push(q)
    }
  }

  return { scope: Array.from(scopeByTrade.values()), clarifying_questions: questions, tradeCollisions }
}

// ── Failure-escalation identity, keyed on Stage 3's real input ─────────
//
// Stage 1/2's files.ai_failure_count (migration 042) is correctly scoped
// per-file, because Stage 1/2 genuinely operates per-file/per-batch of
// files. Stage 3 has no such correspondence — it reasons over the job's
// whole MERGED fact base — so keying its own retry protection off
// files.id is a category mismatch: a fresh re-upload of the exact same
// problematic document mints a new files.id and silently resets the
// counter to zero, letting the same doomed timeout cycle repeat forever
// (the gap the investigation was asked to close). The correct identity is
// the actual Stage 3 input: which document_processing_batches row, and a
// content hash of the exact prompt sent (same hashing approach
// ai-gateway.ts's hashAiInput already uses for idempotency, reused here
// rather than reinvented, so a caller passes the same hash it already
// computed to hashAiInput for the idempotent-reuse check into these
// functions too).
export interface Stage3FailureHistory {
  inputHash: string | null
  classification: AnthropicFailureClassification | null
  count: number
}

// Pre-call guard: true when this exact input has already exhausted its
// allowance (maxConsecutiveOccurrences) for the classification it
// previously failed with — the caller should skip the Claude call entirely
// rather than spend on a call whose outcome, for a byte-identical input, is
// already known. A genuinely different input (different hash) is never
// skipped, regardless of prior history, satisfying "a genuinely changed
// document set gets a fresh attempt allowance."
//
// Boundary matches record_ai_failure's canonical semantics exactly
// (migration 043's `v_stop := v_prior_count >= p_max_occurrences`, evaluated
// against the count BEFORE the failure just recorded): the persisted
// `count` here already includes that most recent failure, so the
// equivalent post-hoc check is `count > max`, not `count >= max` — e.g. for
// application_timeout (max=1), a single recorded failure (count=1) must
// still allow one more attempt (1 > 1 is false); only a SECOND identical
// failure (count=2) stops it (2 > 1 is true), matching "stop after the
// second identical occurrence" documented on maxConsecutiveOccurrences.
export function shouldSkipStage3Call(prior: Stage3FailureHistory, currentInputHash: string): boolean {
  if (!prior.inputHash || !prior.classification) return false
  if (prior.inputHash !== currentInputHash) return false
  return prior.count > maxConsecutiveOccurrences(prior.classification)
}

// Pure state transition for the persisted history (document_processing_
// batches.stage3_failure_input_hash / _classification / _count — see
// migration 059). Mirrors nextFailureHistory's classification-streak logic,
// but ALSO resets the streak whenever the input hash changes — even if the
// classification happens to repeat coincidentally, a different input's
// failure is not evidence the CURRENT input is deterministically doomed.
export function nextStage3FailureHistory(
  prior: Stage3FailureHistory,
  current: { inputHash: string; classification: AnthropicFailureClassification },
): Stage3FailureHistory {
  const sameInputAndClassification =
    prior.inputHash === current.inputHash && prior.classification === current.classification
  return {
    inputHash: current.inputHash,
    classification: current.classification,
    count: sameInputAndClassification ? prior.count + 1 : 1,
  }
}

// ─── AI call timeout + retry ────────────────────────────────────────────────
//
// No Claude (or any provider) call anywhere in this codebase had an explicit
// timeout — a hung upstream TCP connection blocks purely on I/O wait, which
// Supabase's CPU-time governor (metered CPU, not wall clock) never
// interrupts, and Vercel's function timeout is the only backstop on the
// Next.js side (300s, far too coarse to recover gracefully or retry). This
// wraps any such call with an AbortController-backed timeout and a bounded,
// backed-off retry for genuinely transient failures — dependency-free (only
// the AbortController/setTimeout globals both Deno and Node provide) so
// it's the one implementation shared by smooth-responder's callTool and
// every Next.js route that calls the Anthropic SDK, rather than N
// slightly-different copies.
//
// Deliberately NOT retried here: our own timeout firing (application_timeout
// / client_timeout — see classifyAnthropicError above and the incident this
// fixes), and anything else that isn't one of the three transient
// classifications (rate_limited/overloaded/network_interruption). Retrying
// a deterministic failure only burns a second full-price call that will
// fail identically and delays the caller's own failure handling for no
// benefit.

export interface TimedRetryOptions {
  timeoutMs?: number
  maxRetries?: number
  label?: string
  onAttemptFailed?: (info: {
    attempt: number
    durationMs: number
    retryable: boolean
    classification: AnthropicFailureClassification
    error: unknown
  }) => void
}

/**
 * Runs `call` with a hard timeout (aborted via the AbortSignal it's handed —
 * callers MUST pass this signal into the underlying SDK call for the abort
 * to actually cut the in-flight request, not just abandon it locally while
 * it keeps running server-side) and retries only failures classified as
 * transient (see isRetryableClassification) with exponential backoff (1s,
 * 2s, 4s, ...) up to maxRetries times. Always rethrows the last error once
 * retries are exhausted, with `.classification` attached (see
 * `withClassification` below) so callers can make a further-retry/halt/
 * split decision without reclassifying — callers are responsible for their
 * own graceful-failure/DB-update handling on that rethrow, exactly as they
 * already handle any other exception from the call they're wrapping.
 */
export async function withTimeoutAndRetry<T>(
  call: (signal: AbortSignal) => Promise<T>,
  options: TimedRetryOptions = {},
): Promise<T> {
  const { timeoutMs = 60_000, maxRetries = 1, label = 'api_call', onAttemptFailed } = options
  let lastErr: unknown
  let lastClassification: AnthropicFailureClassification = 'unknown'
  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    const startedAt = Date.now()
    try {
      const result = await call(controller.signal)
      clearTimeout(timer)
      return result
    } catch (err) {
      clearTimeout(timer)
      lastErr = err
      const durationMs = Date.now() - startedAt
      const classification = classifyAnthropicError(err, durationMs, timeoutMs)
      lastClassification = classification
      const canRetry = attempt <= maxRetries && isRetryableClassification(classification)
      onAttemptFailed?.({ attempt, durationMs, retryable: canRetry, classification, error: err })
      if (!canRetry) throw withClassification(err, classification)
      await new Promise((resolve) => setTimeout(resolve, 1000 * 2 ** (attempt - 1)))
    }
  }
  // Unreachable — the loop above always either returns or throws — but kept
  // so this compiles under both stripped-TS runtimes without a non-null
  // assertion.
  throw withClassification(lastErr, lastClassification)
}

/** Attaches `.classification` to a thrown error so a catch site doesn't need to re-run classifyAnthropicError (and lose the elapsed/timeoutMs it used). */
function withClassification(err: unknown, classification: AnthropicFailureClassification): unknown {
  if (err && typeof err === 'object') {
    try {
      Object.assign(err as object, { classification })
    } catch { /* frozen/non-extensible error object — fall through, caller can still reclassify */ }
  }
  return err
}

/**
 * Human-readable reason persisted to document_processing_batches.stall_reason
 * when bailForWallClockBudget (index.ts) exits before a stage can safely
 * start. Pure/testable so the exact wording (and the arithmetic it reports)
 * doesn't drift between what's logged and what's persisted — this and the
 * structured `wall_clock_budget_exhausted` log line are the only two places
 * a wall-clock stall is ever described, and they must describe the same
 * event identically.
 */
export function formatWallClockStallReason(
  stage: string,
  neededMs: number,
  elapsedMs: number,
  safetyMs: number,
): string {
  return `Wall-clock safety budget exhausted before stage "${stage}" could start ` +
    `(needed ${neededMs}ms, ${elapsedMs}ms already elapsed this invocation, safety ceiling ${safetyMs}ms) — ` +
    `a scheduling condition, not a content or model failure. The batch will be retried by the recovery ` +
    `cron; a completed Stage 3 checkpoint (if reached) means the retry skips straight to Stage 6.`
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

// ─── Per-document display state (observability) ────────────────────────────
//
// document_processing_jobs only has four DB statuses (pending/running/
// completed/failed) — a document backing off before an automatic retry
// (retry_or_fail_document_job sets it back to 'pending' with attempts > 0
// and a future run_after) is stored identically to a document that simply
// hasn't been claimed yet (also 'pending', attempts = 0). Before this, the
// intake UI showed both as the same plain "waiting" row, so a document that
// had already failed once and was about to be retried looked no different
// from one nothing had gone wrong with — the builder had no way to tell
// "still working through the queue" from "hit a snag, retrying automatically."
// This distinguishes them using the same `attempts` column already recorded
// by the DB, no schema change needed.
export type DocumentDisplayState = 'completed' | 'failed' | 'running' | 'retrying' | 'waiting'

export function documentDisplayState(status: ChildJobStatus, attempts: number): DocumentDisplayState {
  if (status === 'completed') return 'completed'
  if (status === 'failed') return 'failed'
  if (status === 'running') return 'running'
  // status === 'pending': attempts > 0 means a prior attempt already failed
  // and this row is backed off, waiting for retry_or_fail_document_job's
  // scheduled run_after to elapse — not merely unclaimed.
  return attempts > 0 ? 'retrying' : 'waiting'
}

// ─── Deterministic cross-session duplicate detection (Phase 1) ─────────────
//
// Scope, deliberately narrow: byte-identical files re-uploaded to the SAME
// job across separate sessions. Not a "same real-world drawing, re-scanned
// or re-exported" detector (that's LLM/Claude territory — project_documents'
// existing is_duplicate/is_superseded fields, populated per-batch by Stage 1,
// which this deliberately does not touch or extend). This is one rung below
// that: pure byte equality, computed once per file and persisted, so a
// second identical upload is recognized without re-running extraction or
// spending a Stage 1/2 Claude call on content Claude has already seen.

/**
 * SHA-256 of raw file bytes, hex-encoded. Uses the Web Crypto API
 * (`crypto.subtle`), available as a global in both Deno (document-worker's
 * runtime) and Node 22+ (this repo's minimum, per CLAUDE.md) — no new
 * dependency. Same bytes always produce the same hash regardless of
 * filename or upload session; different bytes (even a single-byte diff)
 * produce a different hash.
 */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // Cast needed under newer lib.dom typings: Uint8Array<ArrayBufferLike>
  // (what callers building a view from a Storage-downloaded ArrayBuffer
  // naturally have) isn't structurally assignable to BufferSource's
  // ArrayBuffer-backed generic, even though it's valid at runtime.
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export interface HashedFileCandidate {
  id: string
  job_id: string
  content_hash: string | null
  created_at: string
}

export interface DuplicateDecision {
  isDuplicate: boolean
  originalFileId: string | null
}

/**
 * Pure filter, applied BEFORE decideDuplicateFile: content_hash alone only
 * proves "we have seen these bytes" — it says nothing about whether that
 * earlier file was ever actually usable. Hashing happens before extraction
 * (document-worker computes and persists content_hash regardless of what
 * happens next), so a file whose Stage 1/2 classification later failed, or
 * hasn't run yet, still has a content_hash on record. Without this filter,
 * that file could wrongly serve as the "canonical" match for a future
 * identical re-upload — poisoning it too, forever, even though the
 * original's content was never actually incorporated into any estimate.
 *
 * `completedFileIds` must be sourced from project_documents.extraction_status
 * = 'complete' (migration 050) — the strongest existing signal for genuine
 * success, since it is set ONLY inside persist_document_classification,
 * atomically with the project_facts it depends on. document_processing_jobs
 * .status = 'completed' is NOT sufficient on its own: it only means
 * EXTRACTION succeeded (document-worker's job), a separate, earlier step
 * from CLASSIFICATION (smooth-responder's Stage 1/2, a different
 * invocation entirely) — a file can have a completed extraction job and
 * still never be classified (a billing halt, a permanent AI failure, a
 * crash between the two stages).
 */
export function filterToCanonicalHashCandidates(
  filesWithHash: HashedFileCandidate[],
  completedFileIds: Iterable<string>,
): HashedFileCandidate[] {
  const completedSet = new Set(completedFileIds)
  return filesWithHash.filter((f) => completedSet.has(f.id))
}

/**
 * Pure decision: does `hash` match an already-hashed file in `candidates`,
 * within the SAME job (`selfJobId`), other than `selfId`? `hash` is
 * nullable so a failed hash computation can be represented directly — null
 * always resolves to "not a duplicate," which is the required fail-safe
 * behaviour (a hashing failure must never block or misroute an upload).
 * Filename is deliberately not a parameter: two files with the same name
 * but different bytes are not duplicates, and two files with different
 * names but identical bytes are — matching is content-only. Ties (more
 * than one prior file with the same hash) resolve to the earliest by
 * created_at, then by id, for a stable, deterministic "original"
 * regardless of query row order.
 *
 * job_id is checked HERE, inside the pure function, not left solely to the
 * caller's SQL query filter — WorkA's product model treats each job as an
 * independent client project (see product-readiness audit), so two
 * different jobs containing a byte-identical file (a generic boilerplate
 * spec page, a re-used template) must never be treated as duplicates of
 * each other. The caller's query is still scoped by job_id for efficiency,
 * but this is the structural guarantee: even if a future caller's query
 * ever dropped that filter, this function still cannot cross-match jobs.
 */
export interface CompletedDocumentJobRow {
  document_id: string
  result: { duplicate?: boolean } | null
}

export interface ClassificationPartition {
  /** document_ids eligible to be loaded and sent to Stage 1/2 — everything else was excluded. */
  toClassify: string[]
  /** document_ids whose completed job carries a duplicate marker — never loaded, never built into Claude content. */
  duplicates: string[]
}

/**
 * Pure partition of a batch's completed document_processing_jobs rows into
 * "send to Claude" vs "exact duplicate, already known — skip." This is the
 * actual mechanism that keeps a duplicate's content out of project_facts:
 * a document_id that lands in `duplicates` never gets its file bytes
 * loaded (loadBlockFromExtractionResult, which does real Storage I/O, is
 * only ever called for `toClassify` entries — see loadAllFromExtractionResults
 * in index.ts), so it can never appear in the `documents`/`content` array
 * Claude is given, Claude can never return a file_index for it, and no
 * project_documents/project_facts row can ever be created for it.
 *
 * Extracted as its own pure function (rather than left inline in index.ts,
 * where it originated) specifically so this exact exclusion behaviour has
 * direct unit coverage without a live Supabase/Deno runtime — see the
 * regression test built against this function for the "same document
 * uploaded twice to the same job" scenario end to end at the decision
 * level: second upload's document_id is guaranteed to land in
 * `duplicates`, never in `toClassify`.
 */
export function partitionCompletedJobsForClassification(
  jobs: CompletedDocumentJobRow[],
): ClassificationPartition {
  const toClassify: string[] = []
  const duplicates: string[] = []
  for (const j of jobs) {
    if (j.result?.duplicate) {
      duplicates.push(j.document_id)
    } else {
      toClassify.push(j.document_id)
    }
  }
  return { toClassify, duplicates }
}

export function decideDuplicateFile(
  hash: string | null,
  candidates: HashedFileCandidate[],
  selfId: string,
  selfJobId: string,
): DuplicateDecision {
  if (!hash) return { isDuplicate: false, originalFileId: null }

  const matches = candidates.filter((c) => c.id !== selfId && c.job_id === selfJobId && c.content_hash === hash)
  if (matches.length === 0) return { isDuplicate: false, originalFileId: null }

  const earliest = [...matches].sort((a, b) => {
    const byTime = new Date(a.created_at).getTime() - new Date(b.created_at).getTime()
    return byTime !== 0 ? byTime : a.id.localeCompare(b.id)
  })[0]

  return { isDuplicate: true, originalFileId: earliest.id }
}
