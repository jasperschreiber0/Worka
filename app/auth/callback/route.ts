import {createRouteHandlerClient} from '@supabase/auth-helpers-nextjs'
import {cookies} from 'next/headers'
import {NextRequest, NextResponse} from 'next/server'
import {finishConfirmation} from '@/lib/auth-confirmation'

export const dynamic = 'force-dynamic'

export async function GET(request: NextRequest) {
  const destination = await finishConfirmation(request.nextUrl.searchParams, async code => {
    const client = createRouteHandlerClient({cookies})
    return client.auth.exchangeCodeForSession(code)
  })
  // A relative Location preserves the public hostname behind the hosting proxy.
  return new NextResponse(null, {status: 303, headers: {
    Location: destination,
    'Cache-Control': 'private, no-store',
    'Referrer-Policy': 'no-referrer',
  }})
}
