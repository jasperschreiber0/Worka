// Module-level singleton — survives between requests in the same Railway process.
// Stores uploaded file bytes so the intake pipeline can access them without
// Supabase Storage being configured.

interface CachedFile {
  base64: string
  mediaType: string
  filename: string
  cachedAt: number
}

const CACHE = new Map<string, CachedFile>()

// Evict entries older than 30 minutes to prevent memory bloat
const TTL_MS = 30 * 60 * 1000

function evict() {
  const now = Date.now()
  Array.from(CACHE.entries()).forEach(([id, entry]) => {
    if (now - entry.cachedAt > TTL_MS) CACHE.delete(id)
  })
}

export function cacheFile(fileId: string, base64: string, mediaType: string, filename: string) {
  evict()
  CACHE.set(fileId, { base64, mediaType, filename, cachedAt: Date.now() })
}

export function getCachedFile(fileId: string): CachedFile | null {
  return CACHE.get(fileId) ?? null
}

export function deleteCachedFile(fileId: string) {
  CACHE.delete(fileId)
}
