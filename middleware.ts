import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import type { Database } from '@/lib/types/database.types'

// Protected routes that require an authenticated session
const PROTECTED = ['/studio', '/today', '/business', '/chat', '/settings', '/jobs', '/team', '/suppliers', '/variations']

export async function middleware(req: NextRequest) {
  const res = NextResponse.next()

  // Only the explicit loopback launcher may bypass account authentication.
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    if(process.env.WORKA_LOCAL_STUDIO==='1'&&['localhost','127.0.0.1','[::1]'].includes(req.nextUrl.hostname))return res
    return new NextResponse('Worka account access is not configured. Please contact the builder.',{status:503})
  }

  const path = req.nextUrl.pathname

  // Only run auth checks on protected paths
  const isProtected = PROTECTED.some((p) => path === p || path.startsWith(p + '/'))
  if (!isProtected || path.startsWith('/studio/review/')) return res

  const supabase = createMiddlewareClient<Database>({ req, res })
  // getUser() re-verifies the session against the Supabase Auth server
  // instead of trusting the cookie payload as-is (getSession() does not
  // authenticate it) — see https://supabase.com/docs/guides/auth/server-side/nextjs
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.search=''
    loginUrl.searchParams.set('next', path+req.nextUrl.search)
    return NextResponse.redirect(loginUrl)
  }

  return res
}

export const config = {
  matcher: [
    '/studio', '/studio/:path*',
    '/today', '/today/:path*', '/business', '/business/:path*',
    '/chat', '/chat/:path*',
    '/settings', '/settings/:path*',
    '/jobs', '/jobs/:path*',
    '/team', '/team/:path*',
    '/suppliers', '/suppliers/:path*',
    '/variations', '/variations/:path*',
  ],
}
