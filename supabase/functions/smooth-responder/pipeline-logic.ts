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
}

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
