// ─── PDF text-layer extraction ──────────────────────────────────────────────
//
// The intake and rate-import pipelines send a PDF to Claude as a rendered
// `document` block. For clean drawings that works well, but for price tables
// (a builder's estimate / BOQ / trade breakdown) the model routinely misreads
// column-aligned Rate / Total columns — pairing the wrong number with a line,
// or missing them entirely — which produces an empty, $0 quote.
//
// The PDF's *text layer* holds every number reliably; only the column↔line
// association is hard to reconstruct visually. So we extract the text layer
// server-side and hand it to the model as the authoritative source for numbers,
// while the rendered document still carries the visual structure and context.
//
// Best-effort by design: image-only scans have no text layer and return '',
// and any failure returns '' rather than throwing — the pipeline falls back to
// the document block alone, exactly as before.

const MAX_TEXT_CHARS = 40_000

/**
 * Extract the text layer from a base64-encoded PDF. Returns trimmed text, or ''
 * for image-only PDFs / any failure. Never throws. Uses unpdf, which bundles a
 * serverless build of pdf.js (no native binaries, safe on Vercel/Railway).
 */
export async function extractPdfText(base64: string): Promise<string> {
  try {
    const { extractText, getDocumentProxy } = await import('unpdf')
    const bytes = Uint8Array.from(Buffer.from(base64, 'base64'))
    const pdf = await getDocumentProxy(bytes)
    const result = await extractText(pdf, { mergePages: true })
    const raw = Array.isArray(result.text) ? result.text.join('\n') : result.text
    return (raw ?? '').trim().slice(0, MAX_TEXT_CHARS)
  } catch {
    return ''
  }
}

/**
 * A PDF is worth attaching a text layer for only when it actually carries one.
 * A handful of characters is just page numbers / a title block on a drawing —
 * not a price table — so we gate on a minimum length before spending context.
 */
export function hasUsableText(text: string): boolean {
  return text.length >= 200
}

/**
 * Wrap extracted text in a self-describing block the model can treat as ground
 * truth for numbers. Kept adjacent to its source document in the message.
 */
export function buildTextLayerBlock(text: string): { type: 'text'; text: string } {
  return {
    type: 'text',
    text:
      `--- EXTRACTED TEXT LAYER OF THE PRIMARY DOCUMENT (authoritative for all numbers) ---\n` +
      `This is the raw text extracted directly from the document above. If the document is a ` +
      `priced quote, estimate, bill of quantities, or trade breakdown, use THESE exact figures ` +
      `for rate, line_total and quantity — the text layer is more reliable than reading the ` +
      `rendered table, where columns can be misaligned. Amounts appear in document order; pair ` +
      `each amount with the nearest preceding line description. Treat printed amounts as COST ` +
      `(exclude any margin/builder's fee and GST). If a line has no printed price, leave it null.\n\n` +
      text,
  }
}
