import { createMiddlewareClient } from '@supabase/auth-helpers-nextjs'
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import type { Database } from '@/lib/types/database.types'

// Protected routes that require an authenticated session
const PROTECTED = ['/chat', '/settings', '/jobs']

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
  const { data: { session } } = await supabase.auth.getSession()

  if (!session) {
    const loginUrl = req.nextUrl.clone()
    loginUrl.pathname = '/login'
    loginUrl.searchParams.set('next', path)
    return NextResponse.redirect(loginUrl)
  }

  return res
}

export const config = {
  matcher: ['/chat', '/chat/:path*', '/settings', '/settings/:path*', '/jobs', '/jobs/:path*'],
}
