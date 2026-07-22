// ─── Phase 2 measurement tool: document similarity signals ─────────────────
//
// Purpose: generate a labelled dataset of candidate near-duplicate document
// pairs from real production data, so Gate 3 (reliable cross-session
// matching for documents that are the SAME real-world drawing but not
// byte-identical) can be designed against evidence instead of assumption —
// see PHASE_2_DOCUMENT_MATCHING_READINESS.md for why that ordering matters,
// and PHASE_2_REVIEW_PROCESS.md for how a human reviewer is meant to use
// this dataset once exported.
//
// This module is DELIBERATELY inert: it only computes descriptive signals,
// deterministic explanations, and a ranking score for a pair of documents.
// It does not classify, merge, supersede, or write anything back to
// project_documents/files/project_facts, and nothing in the estimating
// pipeline (Stage 1-6) calls it. `likely_category` is a coarse, human-
// facing triage label for a person skimming an export, not a decision —
// see its own comment. `human_label`/`reviewed_by`/`reviewed_at`/`notes`
// are always null at generation time — they exist as placeholders for a
// human to fill in externally (e.g. in the exported CSV), never written by
// this code.
//
// Pure and dependency-free (same reason pipeline-logic.ts is) so it's
// directly unit-testable with `node --experimental-strip-types --test`.
// No LLM calls anywhere in this file — every explanation is a deterministic
// string built from already-computed signal values.

// ─── Filename normalization + similarity ───────────────────────────────────

/**
 * Lowercase, strip the extension, collapse whitespace/underscore/dash runs
 * to a single space, and strip common OS/browser duplicate-upload suffixes
 * (" (1)", " - copy", "_copy2", etc.). Deliberately does NOT strip revision
 * tokens (v1/v2/rev-a/-final) — those are meaningful for a human labeling
 * the dataset, not noise to erase (see extractRevisionMarkers below, which
 * reads the UNNORMALIZED filename for exactly this reason).
 */
export function normalizeFilename(filename: string): string {
  const withoutExt = filename.includes('.') ? filename.slice(0, filename.lastIndexOf('.')) : filename
  return withoutExt
    .toLowerCase()
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s*\(\d+\)\s*$/, '') // trailing " (1)", " (2)"
    .replace(/\s*copy\s*\d*\s*$/, '') // trailing "copy", "copy 2"
    .trim()
}

/** Levenshtein edit distance — small, pure, no dependency. */
function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  if (a.length === 0) return b.length
  if (b.length === 0) return a.length

  let prevRow = Array.from({ length: b.length + 1 }, (_, i) => i)
  for (let i = 1; i <= a.length; i++) {
    const currRow = [i]
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      currRow.push(Math.min(currRow[j - 1] + 1, prevRow[j] + 1, prevRow[j - 1] + cost))
    }
    prevRow = currRow
  }
  return prevRow[b.length]
}

/**
 * 0..1 similarity between two filenames, after normalization. 1 means
 * identical after normalization; 0 means completely different. Filename
 * alone is never sufficient signal (see Phase 1's own test suite — same
 * filename, different content, is explicitly NOT a duplicate) — this is
 * one input among several, never used alone.
 */
export function filenameSimilarity(a: string, b: string): number {
  const normA = normalizeFilename(a)
  const normB = normalizeFilename(b)
  if (normA.length === 0 && normB.length === 0) return 1
  const maxLen = Math.max(normA.length, normB.length)
  if (maxLen === 0) return 1
  return 1 - levenshtein(normA, normB) / maxLen
}

// ─── Extracted-text overlap (shingle Jaccard) ──────────────────────────────

// Bounds compute cost per comparison — this is a triage tool run over many
// pairs, not a one-off; a multi-hundred-page specification shouldn't make
// one pair comparison dominate the whole report's runtime. Consistent with
// this codebase's existing "cap for cost/safety" pattern (e.g.
// STAGE3_MAX_EVIDENCE_CHARS in pipeline-logic.ts).
export const TEXT_OVERLAP_MAX_CHARS = 20_000
const SHINGLE_SIZE = 5

function shingles(text: string, size: number): Set<string> {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean)
  const result = new Set<string>()
  for (let i = 0; i + size <= words.length; i++) {
    result.add(words.slice(i, i + size).join(' '))
  }
  return result
}

/**
 * Jaccard similarity (0..1) over word-shingles of the two texts. Returns
 * null — not 0 — when either side has no extracted text available (vision-
 * only documents have none persisted; see smooth-responder's vision-
 * selective processing), so "no signal" is never confused with "confirmed
 * different." Callers must treat null as "unknown," not "unrelated" —
 * this is what requirement "missing text does not reduce safety" means in
 * practice: a null never silently becomes a 0 anywhere downstream.
 */
export function textShingleOverlap(textA: string | null, textB: string | null): number | null {
  if (!textA || !textB) return null
  const a = shingles(textA.slice(0, TEXT_OVERLAP_MAX_CHARS), SHINGLE_SIZE)
  const b = shingles(textB.slice(0, TEXT_OVERLAP_MAX_CHARS), SHINGLE_SIZE)
  if (a.size === 0 && b.size === 0) return null // too short to shingle meaningfully
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  a.forEach((s) => { if (b.has(s)) intersection++ })
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : Math.round((intersection / union) * 1000) / 1000
}

// ─── Other coarse signals ───────────────────────────────────────────────────

const FILE_SIZE_TOLERANCE_PCT = 0.1
const FILE_SIZE_TOLERANCE_MIN_BYTES = 10_000 // floor so tiny files aren't falsely split by a % tolerance

/**
 * Boolean "same size bucket" check (with a tolerance floor for tiny
 * files) — kept for likely_category's own thresholding. See
 * fileSizeSimilarity below for the continuous score exposed to reviewers.
 * null (not false) when either side's size is unknown.
 */
export function fileSizeRangeMatch(bytesA: number | null, bytesB: number | null): boolean | null {
  if (bytesA == null || bytesB == null) return null
  const tolerance = Math.max(FILE_SIZE_TOLERANCE_MIN_BYTES, Math.max(bytesA, bytesB) * FILE_SIZE_TOLERANCE_PCT)
  return Math.abs(bytesA - bytesB) <= tolerance
}

/**
 * Continuous 0..1 file-size similarity (1 = identical size, 0 = maximally
 * different) — more informative for a human reviewer than a bare boolean.
 * null when either side's size is unknown (files uploaded before migration
 * 063, or a hash failure on that file — see files.file_size_bytes' own
 * caveats).
 */
export function fileSizeSimilarity(bytesA: number | null, bytesB: number | null): number | null {
  if (bytesA == null || bytesB == null) return null
  const maxBytes = Math.max(bytesA, bytesB)
  if (maxBytes === 0) return 1
  return Math.round((1 - Math.abs(bytesA - bytesB) / maxBytes) * 1000) / 1000
}

export function pageCountDifference(pageA: number | null, pageB: number | null): number | null {
  if (pageA == null || pageB == null) return null
  return Math.abs(pageA - pageB)
}

/** null when either side has no detected title (document not yet classified, or a photo/handwritten note). */
export function titleMatch(titleA: string | null, titleB: string | null): boolean | null {
  if (!titleA || !titleB) return null
  return titleA.trim().toLowerCase() === titleB.trim().toLowerCase()
}

// ─── Revision markers ────────────────────────────────────────────────────────
//
// Detects POSSIBLE revision/issue/version markers and dates in a filename.
// Deliberately does not compare, order, or infer "newer/older" — that
// requires understanding a builder's own naming convention, which varies,
// and inferring it wrong would be exactly the kind of unearned confidence
// this whole measurement phase exists to avoid. This only reports what was
// found, for a human to interpret.

export interface RevisionMarker {
  type: 'letter_revision' | 'numeric_revision' | 'issue' | 'version' | 'date'
  /** The exact matched substring, e.g. "Rev A", "Issue 03" — for traceability back to the filename. */
  raw: string
  /** Normalized value only (leading zeros stripped for numeric types, letters uppercased) — e.g. "A", "3". Never compared/ordered by this module. */
  value: string
}

// Boundaries use explicit lookaround, not \b — \b treats underscore as a
// word character, so "Plans_2026-07-01.pdf" (a very plausible real
// filename, underscore-separated) would silently fail to match a \b-based
// pattern right after the underscore. (?<![A-Za-z0-9]) / (?![A-Za-z0-9])
// correctly treat "_", "-", ".", and space all as valid separators on
// either side of a marker.
const REVISION_PATTERNS: Array<{ type: RevisionMarker['type']; regex: RegExp }> = [
  // "Rev A", "REV-B", "Revision C", "RevD" — a single letter, never a digit
  // (the numeric pattern below owns digits), so these two never double-match.
  { type: 'letter_revision', regex: /(?<![A-Za-z0-9])rev(?:ision)?[\s._-]*([A-Za-z])(?![A-Za-z0-9])/gi },
  // "Rev 2", "Revision 02"
  { type: 'numeric_revision', regex: /(?<![A-Za-z0-9])rev(?:ision)?[\s._-]*(\d+)(?![A-Za-z0-9])/gi },
  // "Issue 03"
  { type: 'issue', regex: /(?<![A-Za-z0-9])issue[\s._-]*(\d+)(?![A-Za-z0-9])/gi },
  // "Version 4", "v4", "V04" — the leading lookbehind keeps this from
  // matching the "vision" inside "Revision" (the char immediately before
  // that "v" is "e", which IS alphanumeric, so the lookbehind fails there
  // — verified in this function's own tests).
  { type: 'version', regex: /(?<![A-Za-z0-9])v(?:ersion)?[\s._-]*(\d+)(?![A-Za-z0-9])/gi },
  // ISO-ish and DD-MM-YYYY-ish dates embedded in a filename.
  { type: 'date', regex: /(?<![A-Za-z0-9])(\d{4}-\d{2}-\d{2})(?![A-Za-z0-9])/g },
  { type: 'date', regex: /(?<![A-Za-z0-9])(\d{2}[-_.]\d{2}[-_.]\d{4})(?![A-Za-z0-9])/g },
]

/**
 * Scans a FILENAME (not drawing_title/extracted text — deliberately scoped
 * to what the task asked for; title/text-based detection is a natural
 * extension not built here) for possible revision markers. Pure, no
 * ordering/classification — see this section's own header comment.
 */
export function extractRevisionMarkers(filename: string): RevisionMarker[] {
  const markers: RevisionMarker[] = []
  for (const { type, regex } of REVISION_PATTERNS) {
    // Array.from(...) wrapper, not a direct for-of over matchAll()'s
    // iterator — this project's tsconfig target doesn't enable
    // --downlevelIteration, so a raw RegExpStringIterator can't be
    // for-of'd directly (see CLAUDE.md's "TypeScript Compatibility Rules":
    // the same reason Set/Map.entries() need Array.from() wrappers here).
    // Not caught by this sandbox's own `tsc --noEmit` (missing @types/node
    // masks it), only by Next.js's real build — verified against the
    // actual Railway build failure this fixes.
    for (const match of Array.from(filename.matchAll(regex))) {
      const captured = match[1]
      const value = type === 'letter_revision' ? captured.toUpperCase()
        : type === 'date' ? captured
        : String(parseInt(captured, 10))
      markers.push({ type, raw: match[0], value })
    }
  }
  return markers
}

export interface RevisionPairSummary {
  revision_markers_detected: boolean
  revision_values: string[]
}

/** Combines both documents' detected marker values into one pair-level summary — deduped, unordered (see this section's header comment on why no newer/older inference happens here). */
export function summarizeRevisionMarkersForPair(markersA: RevisionMarker[], markersB: RevisionMarker[]): RevisionPairSummary {
  const combinedValues = [...markersA, ...markersB].map((m) => m.value)
  return {
    revision_markers_detected: combinedValues.length > 0,
    revision_values: Array.from(new Set(combinedValues)),
  }
}

// ─── Explanations ────────────────────────────────────────────────────────────

export interface DocumentSimilaritySignals {
  filename_similarity: number
  text_overlap: number | null
  page_count_difference: number | null
  size_similarity: number | null
  title_match: boolean | null
}

export interface ExplanationContext {
  sameHash: boolean
  normalizedFilenamesEqual: boolean
  signals: DocumentSimilaritySignals
  revisionValuesA: string[]
  revisionValuesB: string[]
}

/**
 * Deterministic, human-readable explanation of WHY a pair scored the way
 * it did — generated purely from already-computed signal values, no LLM
 * call, no new information. Every branch below reads directly off
 * `ctx.signals`/`ctx.revisionValuesA`/`ctx.revisionValuesB`, so an
 * explanation can never say something the signals don't support (see this
 * function's own test — "explanations match signals"). A missing signal
 * (null) always gets its own explicit "not available" line rather than
 * being silently skipped, so a reviewer never mistakes "no text to
 * compare" for "confirmed no overlap."
 */
export function explainSimilarity(ctx: ExplanationContext): string[] {
  const out: string[] = []
  const { signals } = ctx

  if (ctx.sameHash) out.push('Identical file content (exact byte match)')

  if (ctx.normalizedFilenamesEqual) {
    out.push('Same normalized filename')
  } else if (signals.filename_similarity >= 0.7) {
    out.push(`Similar filename (${Math.round(signals.filename_similarity * 100)}% match)`)
  } else {
    out.push('Filenames are substantially different')
  }

  if (signals.text_overlap == null) {
    out.push('No extracted text available for comparison')
  } else {
    out.push(`${Math.round(signals.text_overlap * 100)}% extracted text overlap`)
  }

  if (signals.page_count_difference == null) {
    out.push('Page count unknown for at least one document')
  } else if (signals.page_count_difference === 0) {
    out.push('Same page count')
  } else {
    out.push(`Page count differs by ${signals.page_count_difference}`)
  }

  if (signals.size_similarity == null) {
    out.push('File size unknown for at least one document')
  } else if (signals.size_similarity >= 0.9) {
    out.push('Similar file size')
  } else if (signals.size_similarity < 0.5) {
    out.push('File sizes differ substantially')
  }
  // Mid-range size similarity gets no line — not informative enough to be
  // worth a reviewer's attention either way.

  if (signals.title_match == null) {
    out.push('Document title not detected for at least one document')
  } else if (signals.title_match) {
    out.push('Same detected document title')
  } else {
    out.push('Different detected document titles')
  }

  const bothHaveMarkers = ctx.revisionValuesA.length > 0 && ctx.revisionValuesB.length > 0
  if (bothHaveMarkers) {
    const setA = new Set(ctx.revisionValuesA)
    const setB = new Set(ctx.revisionValuesB)
    const sameValues = setA.size === setB.size && Array.from(setA).every((v) => setB.has(v))
    out.push(sameValues ? 'Same revision marker detected on both documents' : 'Different revision markers detected')
  } else if (ctx.revisionValuesA.length > 0 || ctx.revisionValuesB.length > 0) {
    out.push('Revision marker present on only one document')
  }

  return out
}

// ─── Composite ───────────────────────────────────────────────────────────────

export interface DocumentSignalInput {
  fileId: string
  filename: string
  contentHash: string | null
  fileSizeBytes: number | null
  pageCount: number | null
  drawingTitle: string | null
  extractedText: string | null
}

export interface DocumentSimilarityResult {
  document_a: string
  document_b: string
  signals: DocumentSimilaritySignals
  explanations: string[]
  similarity_score: number
  likely_category: string
  // Pair-level summary (combined across both documents) — see
  // summarizeRevisionMarkersForPair. Never orders/classifies as newer or
  // older; only reports what was detected.
  revision_markers_detected: boolean
  revision_values: string[]
  // Per-document breakdown, additive beyond what was asked, for
  // traceability — which document has which marker.
  document_a_revision_markers: string[]
  document_b_revision_markers: string[]
  // Review fields — always null when generated. Never written by this
  // module; exist so an exported row has somewhere for a human to record
  // their answer (see PHASE_2_REVIEW_PROCESS.md). No automatic labelling.
  human_label: string | null
  reviewed_by: string | null
  reviewed_at: string | null
  notes: string | null
}

/**
 * Coarse, human-facing triage bucket — a starting point for a person
 * labelling the exported dataset, NOT a classification decision. Nothing
 * reads this to merge, supersede, or filter documents anywhere in the
 * product. 'exact_duplicate' pairs are already fully handled by Phase 1's
 * deterministic content_hash matching before extraction ever runs — they
 * appear here only as a sanity-check/calibration reference point for the
 * other categories, not because Gate 3 needs to do anything about them.
 */
function categorize(
  sameHash: boolean,
  filenameSim: number,
  textOverlap: number | null,
  sameTitle: boolean | null,
  samePageCount: boolean | null,
  similarityScore: number,
): string {
  if (sameHash) return 'exact_duplicate'
  const strongText = textOverlap != null && textOverlap >= 0.6
  const strongFilename = filenameSim >= 0.85
  if (strongText && (samePageCount ?? false)) return 'likely_same_document_different_export'
  if (sameTitle && (strongText || strongFilename)) return 'likely_revision'
  // Falls back to the composite score (which already weighs every
  // available signal, including disconfirming ones like a page-count or
  // file-size mismatch) rather than reacting to any single raw signal in
  // isolation — a single strong signal (e.g. an identical filename) with
  // multiple strongly contradicting ones elsewhere should not, by itself,
  // outrank the overall picture. Mirrors Phase 1's own rule that filename
  // alone is never sufficient evidence of a relationship.
  if (similarityScore >= 0.5) return 'possibly_related'
  return 'unrelated'
}

/**
 * Weighted average of every AVAILABLE signal (0..1 each), renormalized so
 * a missing signal (e.g. no extracted text for a vision-only document)
 * doesn't silently drag the score down — it's excluded from the average
 * entirely rather than counted as 0. filename_similarity is always
 * available (every file has a filename) so the score is never fully
 * undefined. This ranks pairs for human review; it does not decide
 * anything, and nothing in decideDuplicateFile/filterToCanonicalHashCandidates
 * (Phase 1's actual duplicate-suppression logic) reads similarity_score,
 * likely_category, or any field this function produces — see this file's
 * own header comment.
 */
export function computeDocumentSimilarity(a: DocumentSignalInput, b: DocumentSignalInput): DocumentSimilarityResult {
  const sameHash = Boolean(a.contentHash && b.contentHash && a.contentHash === b.contentHash)
  const filenameSim = filenameSimilarity(a.filename, b.filename)
  const normalizedFilenamesEqual = normalizeFilename(a.filename) === normalizeFilename(b.filename)
  const textOverlap = textShingleOverlap(a.extractedText, b.extractedText)
  const sizeSimilarity = fileSizeSimilarity(a.fileSizeBytes, b.fileSizeBytes)
  const sameSizeRange = fileSizeRangeMatch(a.fileSizeBytes, b.fileSizeBytes)
  const samePageCount = a.pageCount != null && b.pageCount != null ? a.pageCount === b.pageCount : null
  const sameTitle = titleMatch(a.drawingTitle, b.drawingTitle)
  const pageDiff = pageCountDifference(a.pageCount, b.pageCount)

  const markersA = extractRevisionMarkers(a.filename)
  const markersB = extractRevisionMarkers(b.filename)
  const revisionSummary = summarizeRevisionMarkersForPair(markersA, markersB)

  const weighted: Array<{ value: number; weight: number }> = [{ value: filenameSim, weight: 0.25 }]
  if (textOverlap != null) weighted.push({ value: textOverlap, weight: 0.35 })
  if (samePageCount != null) weighted.push({ value: samePageCount ? 1 : 0, weight: 0.15 })
  if (sameSizeRange != null) weighted.push({ value: sameSizeRange ? 1 : 0, weight: 0.15 })
  if (sameTitle != null) weighted.push({ value: sameTitle ? 1 : 0, weight: 0.1 })

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0)
  const rawScore = weighted.reduce((sum, w) => sum + w.value * w.weight, 0) / totalWeight
  const similarityScore = sameHash ? 1 : Math.round(rawScore * 1000) / 1000

  const signals: DocumentSimilaritySignals = {
    filename_similarity: Math.round(filenameSim * 1000) / 1000,
    text_overlap: textOverlap,
    page_count_difference: pageDiff,
    size_similarity: sizeSimilarity,
    title_match: sameTitle,
  }

  const explanations = explainSimilarity({
    sameHash,
    normalizedFilenamesEqual,
    signals,
    revisionValuesA: markersA.map((m) => m.value),
    revisionValuesB: markersB.map((m) => m.value),
  })

  return {
    document_a: a.fileId,
    document_b: b.fileId,
    signals,
    explanations,
    similarity_score: similarityScore,
    likely_category: categorize(sameHash, filenameSim, textOverlap, sameTitle, samePageCount, similarityScore),
    revision_markers_detected: revisionSummary.revision_markers_detected,
    revision_values: revisionSummary.revision_values,
    document_a_revision_markers: markersA.map((m) => m.value),
    document_b_revision_markers: markersB.map((m) => m.value),
    human_label: null,
    reviewed_by: null,
    reviewed_at: null,
    notes: null,
  }
}

/** All unordered pairs within one job's documents — pairing is always job-scoped, matching Phase 1's own cross-job isolation rule (a byte-identical file in a different job is never a duplicate — see decideDuplicateFile). */
export function computeJobDocumentSimilarityPairs(files: DocumentSignalInput[]): DocumentSimilarityResult[] {
  const results: DocumentSimilarityResult[] = []
  for (let i = 0; i < files.length; i++) {
    for (let j = i + 1; j < files.length; j++) {
      results.push(computeDocumentSimilarity(files[i], files[j]))
    }
  }
  return results
}

// ─── Report safety utilities ────────────────────────────────────────────────
//
// Pure, extracted from the admin route (app/api/admin/document-similarity-
// report/route.ts) for the same reason everything else in this file is
// pure: direct unit coverage without a live Supabase/Next.js runtime. These
// exist to bound the report's own cost (pair generation is O(n²) per job)
// and to make its auth decision independently verifiable — see the
// "production safety audit" that added this section for the reasoning.

export interface JobFileGroupable {
  job_id: string
}

/**
 * Groups a flat file list by job_id — the sole mechanism that keeps every
 * downstream pair a same-job pair. computeJobDocumentSimilarityPairs takes
 * no job_id at all (by design — see its own comment), so THIS is where
 * cross-job isolation is actually enforced: as long as every call to
 * computeJobDocumentSimilarityPairs is given one group from this map's
 * output, two different jobs' documents can never appear in the same pair.
 */
export function groupFilesByJob<T extends JobFileGroupable>(files: T[]): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const f of files) {
    const list = map.get(f.job_id) ?? []
    list.push(f)
    map.set(f.job_id, list)
  }
  return map
}

export interface RecencyOrderable {
  created_at: string
}

export interface DocumentCapResult<T> {
  files: T[]
  truncated: boolean
  totalBeforeCap: number
}

/**
 * Caps ONE job's files to the most recent `maxDocuments` before pair
 * generation — pair generation is O(n²), so this bounds a single job's
 * worst-case cost to O(maxDocuments²) regardless of how many files that
 * job has actually accumulated. Real, not hypothetical: this exact
 * codebase's own test fixture ("16 Alfred Street," referenced throughout
 * CLAUDE.md) was re-uploaded many times before Phase 1 existed, and
 * nothing stops a job from accumulating an unusually large file count over
 * many incremental upload sessions. Keeps the MOST RECENT files (most
 * representative of current state), not an arbitrary subset.
 */
export function capDocumentsPerJob<T extends RecencyOrderable>(files: T[], maxDocuments: number): DocumentCapResult<T> {
  if (files.length <= maxDocuments) return { files, truncated: false, totalBeforeCap: files.length }
  const sorted = [...files].sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
  return { files: sorted.slice(0, maxDocuments), truncated: true, totalBeforeCap: files.length }
}

export interface PairCapResult<T> {
  pairs: T[]
  truncated: boolean
  totalBeforeCap: number
}

/**
 * Caps the FINAL returned pair list, independent of the per-job cap above
 * — bounds total response size/memory even when scanning many jobs at
 * once (up to HARD_MAX_JOBS in the route). Assumes the caller has already
 * sorted `pairs` by priority (similarity_score descending, as the route
 * does) before calling this, so truncation keeps the most useful pairs
 * for a reviewer rather than an arbitrary slice.
 */
export function capReturnedPairs<T>(pairs: T[], maxPairs: number): PairCapResult<T> {
  if (pairs.length <= maxPairs) return { pairs, truncated: false, totalBeforeCap: pairs.length }
  return { pairs: pairs.slice(0, maxPairs), truncated: true, totalBeforeCap: pairs.length }
}

export interface AdminAuthDecision {
  allowed: boolean
  status: number
  error: string | null
}

/**
 * Pure auth decision for the admin-secret-gated report route — see that
 * route's own header comment for why a shared secret (not a role system)
 * is used. Fails closed: real mode with no configured secret is rejected
 * (503) before any header is even checked, so a deploy that forgot to set
 * ADMIN_REPORT_SECRET can never accidentally serve real data. A configured
 * secret with a non-matching (or absent) Authorization header is rejected
 * (401), regardless of what the header contains. Demo mode
 * (isRealMode=false) with no configured secret allows through — matches
 * this codebase's existing demo-mode auth posture elsewhere (e.g.
 * middleware.ts skips auth checks in demo mode too), and is harmless here
 * specifically because the route's own demo-mode branch returns zero real
 * data regardless.
 */
export function evaluateAdminAuth(
  isRealMode: boolean,
  configuredSecret: string | undefined | null,
  providedAuthHeader: string | null,
): AdminAuthDecision {
  if (isRealMode && !configuredSecret) {
    return { allowed: false, status: 503, error: 'ADMIN_REPORT_SECRET is not configured' }
  }
  if (configuredSecret && providedAuthHeader !== `Bearer ${configuredSecret}`) {
    return { allowed: false, status: 401, error: 'Unauthorized' }
  }
  return { allowed: true, status: 200, error: null }
}
