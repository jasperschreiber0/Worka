// ─── Rate limiting for Claude-backed routes ───────────────────────────────────
// Chat, classify-document, and email-draft each trigger a paid Anthropic API
// call per request with no cap. This provides a per-builder (falling back to
// per-IP when no builder identity is available) request cap.
//
// Real mode: a DB-backed atomic counter (see migration 021) so the limit
// holds across concurrent requests and serverless instances.
// Demo mode: a simple in-memory fixed window — good enough for a single
// always-warm demo deployment, consistent with the rest of the demo-mode
// in-memory state in this codebase.

export interface RateLimitResult {
  allowed: boolean
}

interface RateLimitOptions {
  /** Max requests allowed within the window. */
  limit: number
  /** Window length, in seconds. */
  windowSeconds: number
}

const globalForRateLimit = globalThis as unknown as {
  __workaDemoRateLimits?: Map<string, { windowStart: number; count: number }>
}
const demoRateLimits: Map<string, { windowStart: number; count: number }> =
  globalForRateLimit.__workaDemoRateLimits ?? (globalForRateLimit.__workaDemoRateLimits = new Map())

function isRealMode(): boolean {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  return Boolean(url && url !== 'your-supabase-url' && process.env.SUPABASE_SERVICE_ROLE_KEY)
}

/**
 * Checks and records one call against the given rate-limit key.
 * Fails open (allows the request) if the limiter itself errors — a rate
 * limiter outage must never take down real traffic.
 */
export async function checkRateLimit(key: string, options: RateLimitOptions): Promise<RateLimitResult> {
  if (isRealMode()) {
    try {
      const { createClient } = await import('@supabase/supabase-js')
      const supabase = createClient(
        process.env.NEXT_PUBLIC_SUPABASE_URL!,
        process.env.SUPABASE_SERVICE_ROLE_KEY!,
        { auth: { persistSession: false } }
      )
      const { data, error } = await supabase.rpc('check_rate_limit', {
        p_key: key,
        p_window_seconds: options.windowSeconds,
        p_limit: options.limit,
      })
      if (error) {
        console.error('[rate-limit] RPC error, failing open:', error.message)
        return { allowed: true }
      }
      return { allowed: data === true }
    } catch (err) {
      console.error('[rate-limit] error, failing open:', err)
      return { allowed: true }
    }
  }

  // Demo mode: in-memory fixed window
  const now = Date.now()
  const windowMs = options.windowSeconds * 1000
  const bucket = demoRateLimits.get(key)
  if (!bucket || now - bucket.windowStart > windowMs) {
    demoRateLimits.set(key, { windowStart: now, count: 1 })
    return { allowed: true }
  }
  bucket.count += 1
  return { allowed: bucket.count <= options.limit }
}

/** 429 JSON response for a rate-limited request. */
export function rateLimitedResponse(): Response {
  return new Response(JSON.stringify({ error: 'Too many requests — please slow down and try again shortly.' }), {
    status: 429,
    headers: { 'Content-Type': 'application/json' },
  })
}
