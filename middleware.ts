import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import type { Database } from '@/lib/types/database.types'

// Protected routes that require an authenticated session
const PROTECTED = ['/chat', '/settings', '/jobs', '/team', '/suppliers', '/variations']

export async function middleware(req: NextRequest) {
  const res = NextResponse.next()

  // Demo mode: if no Supabase URL is configured, skip all auth checks
  if (!process.env.NEXT_PUBLIC_SUPABASE_URL) {
    return res
  }

  const path = req.nextUrl.pathname

  // Only run auth checks on protected paths
  const isProtected = PROTECTED.some((p) => path === p || path.startsWith(p + '/'))
  if (!isProtected) return res

  const supabase = createMiddlewareClient<Database>({ req, res })
  // getUser() re-verifies the session against the Supabase Auth server
  // instead of trusting the cookie payload as-is (getSession() does not
  // authenticate it) — see https://supabase.com/docs/guides/auth/server-side/nextjs
  const { data: { user } } = await supabase.auth.getUser()

  if (!user) {
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('next', path)
    return NextResponse.redirect(loginUrl)
  }

  return res
}

export const config = {
  matcher: [
    '/chat', '/chat/:path*',
    '/settings', '/settings/:path*',
    '/jobs', '/jobs/:path*',
    '/team', '/team/:path*',
    '/suppliers', '/suppliers/:path*',
    '/variations', '/variations/:path*',
  ],
}
