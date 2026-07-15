// ─── PDF page-chunking (Deno) ───────────────────────────────────────────────
//
// Rescues a single PDF that's too large to fit any batch on its own (see
// splitIntoBatches in pipeline-logic.ts) by splitting it into smaller
// page-range PDFs, each of which can be placed into batches independently.
// Only reached for genuinely large, vision-necessary documents — a
// text-dense document this large would already have been reduced to a tiny
// text block by pdf-text.ts's isTextDense path before chunking is ever
// considered, so this is specifically for big scanned/drawing-heavy PDFs
// (a full multi-sheet architectural or structural set) with little or no
// text layer.
//
// Uses pdf-lib (pure JS, no native deps, no canvas/DOM requirement for page
// copying) rather than rendering pages to images — Claude's vision API
// accepts PDF `document` blocks directly and rasterizes server-side, so a
// smaller multi-page (or single-page) PDF is exactly what a "chunk" needs
// to be here.

export interface PdfChunk {
  bytes: Uint8Array
  pageStart: number // 1-based, inclusive
  pageEnd: number // 1-based, inclusive
}

export async function getPdfPageCount(bytes: Uint8Array): Promise<number> {
  const { PDFDocument } = await import('https://esm.sh/pdf-lib@1.17.1')
  const doc = await PDFDocument.load(bytes, { ignoreEncryption: true })
  return doc.getPageCount()
}

/**
 * Splits a PDF into chunks of at most `pagesPerChunk` pages each. Returns a
 * single chunk covering the whole document if it has 1 page or fewer than
 * pagesPerChunk, or on any failure (caller falls back to the original
 * unsplit bytes in that case — see index.ts).
 */
export async function splitPdfIntoChunks(bytes: Uint8Array, pagesPerChunk: number): Promise<PdfChunk[]> {
  const { PDFDocument } = await import('https://esm.sh/pdf-lib@1.17.1')
  const source = await PDFDocument.load(bytes, { ignoreEncryption: true })
  const pageCount = source.getPageCount()

  if (pageCount <= pagesPerChunk) {
    return [{ bytes, pageStart: 1, pageEnd: pageCount }]
  }

  const chunks: PdfChunk[] = []
  for (let start = 0; start < pageCount; start += pagesPerChunk) {
    const end = Math.min(start + pagesPerChunk, pageCount)
    const chunkDoc = await PDFDocument.create()
    const indices = Array.from({ length: end - start }, (_, i) => start + i)
    const copiedPages = await chunkDoc.copyPages(source, indices)
    copiedPages.forEach((p) => chunkDoc.addPage(p))
    const chunkBytes = await chunkDoc.save()
    chunks.push({ bytes: chunkBytes, pageStart: start + 1, pageEnd: end })
  }
  return chunks
}
