/** Authenticate alternate valid legacy service tokens without trusting decoded claims.
 * The zero-row HEAD is verified by this project's Data API and server-only grants.
 * It reads no records. Gateway JWT verification must remain enabled as defense in depth.
 */
export async function isServiceRoleRequest(authorization: string | null, serviceKey: string, url: string, request: typeof fetch = fetch): Promise<boolean> {
 const token = authorization?.match(/^Bearer\s+(\S+)$/i)?.[1]
 if (!token || !serviceKey) return false
 if (token === serviceKey) return true
 try {
  const claims = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
  if (claims.role !== 'service_role' || claims.ref !== new URL(url).hostname.split('.')[0]) return false
  // Claims alone never authorize: require the server to verify the supplied credential.
  const response = await request(url.replace(/\/$/, '') + '/rest/v1/estimating_access?select=builder_id&limit=0', {
   method: 'HEAD', headers: {apikey: token, Authorization: 'Bearer ' + token},
   redirect: 'error', signal: AbortSignal.timeout(5000),
  })
  return response.status === 200
 } catch { return false }
}
