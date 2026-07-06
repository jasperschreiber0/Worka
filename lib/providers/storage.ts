// ─── Storage provider (infrastructure adapter) ────────────────────────────────
// Loads uploaded file bytes as Claude-ready document blocks (+ optional PDF text
// layer). Wraps the file-cache and Supabase Storage so the extraction service
// depends on this port, not on Supabase.

export interface LoadedDoc {
  file_id: string
  filename: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  block: any
  /** extracted PDF text layer if usable (drives the letterhead backstop) */
  textLayer?: string
}

export interface StoragePort {
  load(fileIds: string[], builderId: string): Promise<LoadedDoc[]>
}

/** Real storage port — file-cache first, then Supabase Storage download. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function createSupabaseStorage(supabase: any): StoragePort {
  return {
    async load(fileIds, builderId) {
      const { getCachedFile } = await import('@/lib/file-cache')
      const { extractPdfText, hasUsableText, buildTextLayerBlock } = await import('@/lib/pdf-text')
      const MAX_TOTAL_BYTES = 20 * 1024 * 1024
      let attached = 0
      const out: LoadedDoc[] = []

      for (const fileId of fileIds.slice(0, 8)) {
        let base64: string | null = null
        let mediaType = 'application/pdf'
        let filename = fileId

        const cached = getCachedFile(fileId)
        if (cached) {
          base64 = cached.base64
          mediaType = cached.mediaType
          filename = cached.filename ?? fileId
        } else {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const rowRes: any = await Promise.race([
            supabase.from('files').select('*').eq('id', fileId).eq('builder_id', builderId).single(),
            new Promise((resolve) => setTimeout(() => resolve({ data: null }), 8_000)),
          ])
          const row = rowRes?.data
          if (!row) continue
          filename = row.filename ?? fileId
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const dl: any = await Promise.race([
            supabase.storage.from('plans').download(row.storage_path),
            new Promise((resolve) => setTimeout(() => resolve({ data: null }), 30_000)),
          ])
          if (!dl?.data) continue
          base64 = Buffer.from(await dl.data.arrayBuffer()).toString('base64')
          mediaType = row.file_type === 'pdf' ? 'application/pdf' : 'image/jpeg'
        }
        if (!base64) continue

        const bytes = Math.ceil(base64.length * 0.75)
        if (attached + bytes > MAX_TOTAL_BYTES) continue
        attached += bytes

        const isPdf = mediaType.includes('pdf')
        const isCsv = mediaType.includes('csv') || mediaType.includes('text/plain')
        let textLayer: string | undefined
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let block: any

        if (isCsv) {
          const csvText = Buffer.from(base64, 'base64').toString('utf-8')
          block = { type: 'text', text: `FILE ${filename}:\n\`\`\`\n${csvText.slice(0, 40000)}\n\`\`\`` }
          textLayer = csvText
        } else if (isPdf) {
          block = { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: base64 } }
          const text: string = await Promise.race([
            extractPdfText(base64),
            new Promise<string>((resolve) => setTimeout(() => resolve(''), 12_000)),
          ])
          if (hasUsableText(text)) textLayer = text
        } else {
          block = { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64 } }
        }

        out.push({ file_id: fileId, filename, block, textLayer })
      }
      return out
    },
  }
}
