import createIntlMiddleware from 'next-intl/middleware'
import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { routing } from '@/i18n/routing'

const intlMiddleware = createIntlMiddleware(routing)

export async function proxy(request: NextRequest) {
  // Skip intl for auth callback
  if (request.nextUrl.pathname.startsWith('/auth/')) {
    return NextResponse.next()
  }

  // Let intl handle the routing (redirects / to /ar)
  const response = intlMiddleware(request)

  // Now check auth for protected routes
  const pathname = request.nextUrl.pathname
  const isProtected = pathname.match(/^\/(ar|en)\/dashboard/)

  if (isProtected) {
    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
      {
        cookies: {
          getAll() {
            return request.cookies.getAll()
          },
          setAll(cookiesToSet) {
            cookiesToSet.forEach(({ name, value, options }) =>
              response.cookies.set(name, value, options)
            )
          },
        },
      }
    )

    const { data: { user } } = await supabase.auth.getUser()

    if (!user) {
      const locale = pathname.split('/')[1]
      const url = request.nextUrl.clone()
      url.pathname = `/${locale}/login`
      return NextResponse.redirect(url)
    }
  }

  return response
}

export const config = {
  matcher: [
    // api/ and widget.js are called from third-party sites and must not get a locale redirect
    '/((?!api/|_next/static|_next/image|favicon.ico|widget\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}