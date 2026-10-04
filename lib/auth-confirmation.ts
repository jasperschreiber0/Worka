import {loginDestination} from './studio-access.ts'

export const confirmationFailure = '/login?confirmation=failed'

/** Exchange only through the cookie-backed auth client; never trust URL claims. */
export async function finishConfirmation(
  params: URLSearchParams,
  exchange: (code: string) => Promise<{error: unknown}>,
) {
  const code = params.get('code')
  if (params.has('error') || !code || code.length > 4096) return confirmationFailure
  try {
    const result = await exchange(code)
    return result.error ? confirmationFailure : loginDestination(params.get('next'))
  } catch {
    return confirmationFailure
  }
}
