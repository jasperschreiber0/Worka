// ─── Worker portal session ─────────────────────────────────────────────────
// Workers don't have full Supabase Auth accounts (no email/password) — this
// is a lightweight, cookie-based session established when a worker
// completes the /join/[token] flow, so /worker can identify which real
// worker is asking instead of always serving demo data to anyone.
//
// Same pattern as the variation share tokens (migration 018): a random
// token is handed to the browser, only its SHA-256 hash is stored server
// side, so reading the database never exposes a valid session credential.

import { randomBytes, createHash } from 'crypto'

export const WORKER_SESSION_COOKIE = 'worka_worker_session'
export const WORKER_SESSION_TTL_MS = 90 * 24 * 60 * 60 * 1000 // 90 days

export function generateWorkerSessionToken(): { rawToken: string; tokenHash: string; expiresAt: string } {
  const rawToken = randomBytes(24).toString('base64url')
  const tokenHash = hashWorkerSessionToken(rawToken)
  const expiresAt = new Date(Date.now() + WORKER_SESSION_TTL_MS).toISOString()
  return { rawToken, tokenHash, expiresAt }
}

export function hashWorkerSessionToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

export function isWorkerSessionExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return true
  return new Date(expiresAt).getTime() < Date.now()
}
