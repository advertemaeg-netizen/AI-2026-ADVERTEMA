import createIntlMiddleware from 'next-intl/middleware'
import { type NextRequest, NextResponse } from 'next/server'
import { createServerClient } from '@supabase/ssr'
import { routing } from '@/i18n/routing'
import { hostRoute } from '@/site/host-routing'

const intlMiddleware = createIntlMiddleware(routing)

export async function proxy(request: NextRequest) {
  // The marketing site's hosts first (src/site/host-routing.ts): they serve
  // its pages only, and the app's host never shows them
  const site = hostRoute(request.headers.get('host'), request.nextUrl.pathname, request.nextUrl.search)
  if (site.kind === 'rewrite') return NextResponse.rewrite(new URL(site.to, request.url))
  if (site.kind === 'redirect') return NextResponse.redirect(new URL(site.to, request.url), site.status)
  // The catch-all route answers it with the translated 404
  if (site.kind === 'notFound') return NextResponse.rewrite(new URL(`/${site.locale}/_not-found`, request.url))
  if (site.kind === 'locale') return intlMiddleware(request)

  // /api is in the matcher only for the site's hosts (above): on the app's
  // host it goes straight through, as it did before
  if (request.nextUrl.pathname.startsWith('/api/')) {
    return NextResponse.next()
  }

  // Skip intl for auth callback
  if (request.nextUrl.pathname.startsWith('/auth/')) {
    return NextResponse.next()
  }

  // Let intl handle the routing (redirects / to /ar)
  const response = intlMiddleware(request)

  // Now check auth for protected routes
  const pathname = request.nextUrl.pathname
  const isProtected = pathname.match(/^\/(ar|en)\/(dashboard|admin)/)

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
    // widget.js is called from third-party sites and must not get a locale
    // redirect. /api is matched so the site's hosts can send it to the app's
    // host; on the app's host the proxy passes it through untouched.
    '/((?!_next/static|_next/image|favicon.ico|widget\\.js|.*\\.(?:svg|png|jpg|jpeg|gif|webp)$).*)',
  ],
}