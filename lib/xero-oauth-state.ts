import crypto from 'node:crypto'

const MAX_AGE_SECONDS = 10 * 60

function secret(): string {
  return process.env.XERO_OAUTH_STATE_SECRET || process.env.XERO_TOKEN_ENCRYPTION_KEY || ''
}

function mac(payload: string): string {
  return crypto.createHmac('sha256', secret()).update(payload).digest('base64url')
}

export function createXeroOAuthState(builderId: string, now = Date.now()): string {
  if (!secret()) throw new Error('Xero state signing is not configured')
  const payload = `${builderId}.${now}.${crypto.randomBytes(24).toString('base64url')}`
  return `${payload}.${mac(payload)}`
}

export function verifyXeroOAuthState(state: string | null | undefined, builderId: string, now = Date.now()): boolean {
  if (!state || state.length > 512 || !secret()) return false
  const parts = state.split('.')
  if (parts.length !== 4) return false
  const [stateBuilderId, issuedAt, nonce, signature] = parts
  if (!stateBuilderId || !issuedAt || !nonce || !signature || stateBuilderId !== builderId) return false
  const issued = Number(issuedAt)
  if (!Number.isSafeInteger(issued) || issued > now + 30_000 || now - issued > MAX_AGE_SECONDS * 1000) return false
  const expected = mac(`${stateBuilderId}.${issuedAt}.${nonce}`)
  const a = Buffer.from(signature)
  const b = Buffer.from(expected)
  return a.length === b.length && crypto.timingSafeEqual(a, b)
}

export const XERO_OAUTH_STATE_COOKIE = 'worka_xero_oauth_state'
export const XERO_OAUTH_STATE_MAX_AGE = MAX_AGE_SECONDS

export function hashXeroOAuthState(state: string): string {
  return crypto.createHash('sha256').update(state).digest('hex')
}

export function xeroStateCookieOptions(clear = false) {
  return { httpOnly: true, secure: process.env.NODE_ENV === 'production', sameSite: 'lax' as const,
    path: '/api/xero', maxAge: clear ? 0 : MAX_AGE_SECONDS, ...(clear ? { expires: new Date(0) } : {}) }
}

// The database adapter MUST atomically delete-and-return the unexpired row.
// This gate is shared by the real callback and tests; side effects happen only
// after it returns true. Cookie clearing alone cannot enforce single use.
export async function consumeXeroCallbackState(input: {
  state: string | null; cookie: string | undefined; builderId: string | null; code: string | null;
}, consume: (hash: string, builderId: string) => Promise<boolean>, now = Date.now()): Promise<boolean> {
  const { state, cookie, builderId, code } = input
  if (!builderId || !code || !state || !cookie || !verifyXeroOAuthState(state, builderId, now)) return false
  const a = Buffer.from(state); const b = Buffer.from(cookie)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false
  return consume(hashXeroOAuthState(state), builderId)
}

export async function runXeroOAuthCallback(
  input: Parameters<typeof consumeXeroCallbackState>[0],
  consume: Parameters<typeof consumeXeroCallbackState>[1],
  exchangeAndSave: () => Promise<void>,
  now = Date.now(),
): Promise<boolean> {
  if (!await consumeXeroCallbackState(input, consume, now)) return false
  await exchangeAndSave()
  return true
}
