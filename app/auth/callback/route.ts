import { NextResponse, type NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { appOrigin } from '@/lib/app-url'

/**
 * Where Supabase email links (sign-up confirmation, invite sign-up) land:
 * /auth/callback?code=… — outside [locale], matching the emailRedirectTo the
 * sign-up forms send (proxy.ts skips the locale redirect for /auth/*).
 * Exchanges the PKCE code for a session cookie, then continues to `next`.
 */
export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get('code')
  const next = request.nextUrl.searchParams.get('next')
  // Internal paths only — "//evil.com" would be an open redirect
  const safeNext =
    next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/\\') ? next : '/dashboard'
  // The public origin, not request.url: behind Traefik that's plain http
  const origin = await appOrigin()

  if (code) {
    const supabase = await createClient()
    const { error } = await supabase.auth.exchangeCodeForSession(code)
    if (!error) return NextResponse.redirect(`${origin}${safeNext}`)
  }

  return NextResponse.redirect(`${origin}/login?error=auth`)
}
