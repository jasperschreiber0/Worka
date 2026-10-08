const hostedOrigins = new Set([
  'https://getworka.com',
  'https://www.getworka.com',
  'https://worka-production.up.railway.app',
])

/** Railway terminates HTTPS before Next.js, so nextUrl may use an internal origin. */
export function isStudioOrigin(origin: string | null, requestOrigin: string, fetchSite: string | null) {
  if (fetchSite === 'cross-site') return false
  if (!origin) return true
  if(origin === requestOrigin || hostedOrigins.has(origin))return true
  // Next's development server can report localhost for a 127.0.0.1 request.
  // Accept only the loopback aliases on the same protocol and port.
  try{const source=new URL(origin),target=new URL(requestOrigin),loopback=new Set(['localhost','127.0.0.1','[::1]']);return origin===source.origin&&loopback.has(source.hostname)&&loopback.has(target.hostname)&&source.protocol===target.protocol&&source.port===target.port}catch{return false}
}
