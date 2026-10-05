type BucketResult = {data: {public: boolean} | null; error: unknown}
type BucketService = {
  getBucket: (name: string) => Promise<BucketResult>
  createBucket: (name: string, options: {public: boolean; fileSizeLimit: number; allowedMimeTypes: string[]}) => Promise<unknown>
}
export const renderBucket = 'studio-renders'

function missingBucket(error: unknown) {
  if (!error || typeof error !== 'object') return false
  const e = error as {status?: unknown; statusCode?: unknown; code?: unknown}
  // Legacy Storage returns HTTP 400 with a 404 or NoSuchBucket body code.
  return e.status === 404 || ['404', 'NoSuchBucket', 'not_found'].includes(String(e.statusCode)) || e.code === 'NoSuchBucket'
}

export async function ensurePrivateRenderBucket(storage: BucketService,bucket=renderBucket,mimeTypes=['application/json'],size=32000000) {
  let result = await storage.getBucket(bucket)
  if (missingBucket(result.error)) {
    await storage.createBucket(bucket, {public:false, fileSizeLimit:size, allowedMimeTypes:mimeTypes})
    // Also covers another request creating it concurrently. Always verify privacy.
    result = await storage.getBucket(bucket)
  }
  if (result.error || !result.data || result.data.public !== false) throw new Error('Private image storage is unavailable.')
}
