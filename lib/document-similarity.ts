// ─── Phase 2 measurement tool: document similarity signals ─────────────────
//
// Purpose: generate a labelled dataset of candidate near-duplicate document
// pairs from real production data, so Gate 3 (reliable cross-session
// matching for documents that are the SAME real-world drawing but not
// byte-identical) can be designed against evidence instead of assumption —
// see PHASE_2_DOCUMENT_MATCHING_READINESS.md for why that ordering matters.
//
// This module is DELIBERATELY inert: it only computes descriptive signals
// and a ranking score for a pair of documents. It does not classify,
// merge, supersede, or write anything back to project_documents/files/
// project_facts, and nothing in the estimating pipeline (Stage 1-6) calls
// it. `likely_category` is a coarse, human-facing triage label for a
// person skimming an export, not a decision — see its own comment.
//
// Pure and dependency-free (same reason pipeline-logic.ts is) so it's
// directly unit-testable with `node --experimental-strip-types --test`.

// ─── Filename normalization + similarity ───────────────────────────────────

/**
 * Lowercase, strip the extension, collapse whitespace/underscore/dash runs
 * to a single space, and strip common OS/browser duplicate-upload suffixes
 * (" (1)", " - copy", "_copy2", etc.). Deliberately does NOT strip revision
 * tokens (v1/v2/rev-a/-final) — those are meaningful for a human labeling
 * the dataset, not noise to erase.
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
 * different." Callers must treat null as "unknown," not "unrelated."
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

/** null (not false) when either side's size is unknown — see files.file_size_bytes' own caveats. */
export function fileSizeRangeMatch(bytesA: number | null, bytesB: number | null): boolean | null {
  if (bytesA == null || bytesB == null) return null
  const tolerance = Math.max(FILE_SIZE_TOLERANCE_MIN_BYTES, Math.max(bytesA, bytesB) * FILE_SIZE_TOLERANCE_PCT)
  return Math.abs(bytesA - bytesB) <= tolerance
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
  signals: string[]
  similarity_score: number
  filename_similarity: number
  text_overlap: number | null
  page_count_difference: number | null
  same_file_size_range: boolean | null
  same_detected_title: boolean | null
  likely_category: string
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
 * undefined. This ranks pairs for human review; it does not decide anything.
 */
export function computeDocumentSimilarity(a: DocumentSignalInput, b: DocumentSignalInput): DocumentSimilarityResult {
  const sameHash = Boolean(a.contentHash && b.contentHash && a.contentHash === b.contentHash)
  const filenameSim = filenameSimilarity(a.filename, b.filename)
  const textOverlap = textShingleOverlap(a.extractedText, b.extractedText)
  const sameSizeRange = fileSizeRangeMatch(a.fileSizeBytes, b.fileSizeBytes)
  const samePageCount = a.pageCount != null && b.pageCount != null ? a.pageCount === b.pageCount : null
  const sameTitle = titleMatch(a.drawingTitle, b.drawingTitle)
  const pageDiff = pageCountDifference(a.pageCount, b.pageCount)

  const weighted: Array<{ value: number; weight: number }> = [{ value: filenameSim, weight: 0.25 }]
  if (textOverlap != null) weighted.push({ value: textOverlap, weight: 0.35 })
  if (samePageCount != null) weighted.push({ value: samePageCount ? 1 : 0, weight: 0.15 })
  if (sameSizeRange != null) weighted.push({ value: sameSizeRange ? 1 : 0, weight: 0.15 })
  if (sameTitle != null) weighted.push({ value: sameTitle ? 1 : 0, weight: 0.1 })

  const totalWeight = weighted.reduce((sum, w) => sum + w.weight, 0)
  const rawScore = weighted.reduce((sum, w) => sum + w.value * w.weight, 0) / totalWeight
  const similarityScore = sameHash ? 1 : Math.round(rawScore * 1000) / 1000

  const signals: string[] = []
  if (sameHash) signals.push('exact_content_hash_match')
  if (normalizeFilename(a.filename) === normalizeFilename(b.filename)) signals.push('same_filename_normalized')
  else if (filenameSim >= 0.7) signals.push('similar_filename')
  if (samePageCount) signals.push('same_page_count')
  if (sameSizeRange) signals.push('same_file_size_range')
  if (sameTitle) signals.push('same_detected_title')
  if (textOverlap != null && textOverlap >= 0.5) signals.push('high_text_overlap')
  if (textOverlap == null) signals.push('text_unavailable')

  return {
    document_a: a.fileId,
    document_b: b.fileId,
    signals,
    similarity_score: similarityScore,
    filename_similarity: Math.round(filenameSim * 1000) / 1000,
    text_overlap: textOverlap,
    page_count_difference: pageDiff,
    same_file_size_range: sameSizeRange,
    same_detected_title: sameTitle,
    likely_category: categorize(sameHash, filenameSim, textOverlap, sameTitle, samePageCount, similarityScore),
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
