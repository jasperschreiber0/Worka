const hostedOrigins = new Set([
  'https://getworka.com',
  'https://www.getworka.com',
  'https://worka-production.up.railway.app',
])

/** Railway terminates HTTPS before Next.js, so nextUrl may use an internal origin. */
export function isStudioOrigin(origin: string | null, requestOrigin: string, fetchSite: string | null) {
  if (fetchSite === 'cross-site') return false
  if (!origin) return true
  return origin === requestOrigin || hostedOrigins.has(origin)
}
