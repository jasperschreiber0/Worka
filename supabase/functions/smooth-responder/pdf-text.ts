// ─── PDF text-layer extraction (Deno) ──────────────────────────────────────
//
// Deno-native equivalent of lib/pdf-text.ts (which uses Node's `Buffer` and
// can't run in this edge function's Deno runtime — see CLAUDE.md's
// "Reasoning-First Estimating Engine" section). Same library (`unpdf`,
// which specifically targets serverless/edge runtimes with no native
// binaries), same interface, but base64 is decoded via `atob` instead of
// `Buffer.from(...)` so nothing here depends on a Node global.
//
// This now does double duty beyond the original "numbers are more reliable
// from the text layer than a rendered table" rationale: it also powers
// vision-selective processing in index.ts — a text-dense PDF (a spec sheet,
// fixture schedule, or BOQ) is sent to Claude as text only, skipping the
// far more expensive vision encoding entirely, while a text-sparse PDF
// (an actual drawing) still gets the full vision treatment.

const MAX_TEXT_CHARS = 40_000

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/**
 * Extract the text layer from a base64-encoded PDF. Returns trimmed text, or
 * '' for image-only PDFs / any failure. Never throws — a failed extraction
 * just means the document falls back to vision-only, exactly as before this
 * existed.
 */
export async function extractPdfText(base64: string): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import('https://esm.sh/unpdf@0.12.1')
    const bytes = base64ToBytes(base64)
    const pdf = await getDocumentProxy(bytes)
    const result = await extractText(pdf, { mergePages: true })
    const raw = Array.isArray(result.text) ? result.text.join('\n') : result.text
    return (raw ?? '').trim().slice(0, MAX_TEXT_CHARS)
  } catch {
    return ''
  }
}

// PDF parsing (decompression, font-program interpretation for glyph→text
// mapping) is genuine CPU work, not I/O wait — a large or structurally
// complex PDF (a full CAD/Revit-exported drawing set, especially one with
// embedded/subsetted TrueType fonts) can burn real CPU time extracting a
// text layer that likely wasn't going to be text-dense anyway. Supabase
// Edge Functions enforce a CPU-time budget per invocation, separate from
// wall-clock time, and a CPU-time kill is abrupt — no catch/finally runs,
// so the job lock is never released and the run just retries identically
// once the lock goes stale, forever. Two independent guards:
//   1. Skip extraction entirely above a raw byte-size threshold — these are
//      also the documents least likely to be text-dense, so the vision
//      read was the right call anyway.
//   2. A wall-clock timeout as a second backstop, in case a small file
//      still turns out to be pathologically expensive to parse.
const MAX_EXTRACTABLE_BYTES = 4 * 1024 * 1024
const EXTRACTION_TIMEOUT_MS = 5_000

export async function extractPdfTextBounded(base64: string, rawByteLength: number): Promise<{ text: string; skippedReason?: string }> {
  if (rawByteLength > MAX_EXTRACTABLE_BYTES) {
    return { text: '', skippedReason: `over ${Math.round(MAX_EXTRACTABLE_BYTES / (1024 * 1024))}MB, extraction skipped to avoid CPU-time risk` }
  }
  const timeout = new Promise<{ text: string; skippedReason?: string }>((resolve) =>
    setTimeout(() => resolve({ text: '', skippedReason: `extraction exceeded ${EXTRACTION_TIMEOUT_MS}ms` }), EXTRACTION_TIMEOUT_MS)
  )
  const attempt = extractPdfText(base64).then((text) => ({ text }))
  return Promise.race([attempt, timeout])
}

/**
 * A PDF is worth attaching a text layer for only when it actually carries
 * one. A handful of characters is just page numbers / a title block on a
 * drawing — not worth spending context on.
 */
export function hasUsableText(text: string): boolean {
  return text.length >= 200
}

/**
 * Above this, a document is treated as primarily textual (a specification,
 * fixture schedule, priced BOQ, written scope) rather than a drawing — dense
 * enough that the text layer alone captures essentially everything a vision
 * read would, at a fraction of the token cost. A real architectural
 * elevation or structural drawing, even a detailed one, rarely crosses this
 * — it's mostly graphics, dimensions and a title block, not paragraphs of
 * embedded text. Chosen well above hasUsableText's 200-char gate (which
 * exists to catch "any text worth supplementing a vision read with") so
 * this only fires for documents that are unambiguously text-dominant, not
 * a drawing that merely has a busy title block or a schedule table.
 */
const TEXT_DENSE_THRESHOLD = 2_000

export function isTextDense(text: string): boolean {
  return text.length >= TEXT_DENSE_THRESHOLD
}

/**
 * Wrap extracted text in a self-describing block for a text-dense document
 * being sent WITHOUT its vision block — this is now the document's only
 * representation, not a supplement, so it's framed accordingly.
 */
export function buildTextOnlyBlock(filename: string, text: string): { type: 'text'; text: string } {
  return {
    type: 'text',
    text:
      `--- DOCUMENT: ${filename} (text layer — this document was text-dense enough to process as text rather than an image, to save cost; nothing is lost, the full text layer is below) ---\n` +
      text,
  }
}

/**
 * Wrap extracted text as a supplement alongside a vision block — same
 * framing as the original lib/pdf-text.ts, for a sparse-but-present text
 * layer (e.g. a drawing with a small embedded price table).
 */
export function buildTextLayerBlock(text: string): { type: 'text'; text: string } {
  return {
    type: 'text',
    text:
      `--- EXTRACTED TEXT LAYER OF THE PRECEDING DOCUMENT (authoritative for all numbers) ---\n` +
      `This is the raw text extracted directly from the document above. If the document is a ` +
      `priced quote, estimate, bill of quantities, or trade breakdown, use THESE exact figures ` +
      `for rate, line_total and quantity — the text layer is more reliable than reading the ` +
      `rendered table, where columns can be misaligned. Amounts appear in document order; pair ` +
      `each amount with the nearest preceding line description. Treat printed amounts as COST ` +
      `(exclude any margin/builder's fee and GST). If a line has no printed price, leave it null.\n\n` +
      text,
  }
}
