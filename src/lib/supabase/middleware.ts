import { createServerClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request })

  const supabase = createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY!,
    {
      cookies: {
        getAll() {
          return request.cookies.getAll()
        },
        setAll(cookiesToSet) {
          cookiesToSet.forEach(({ name, value }) =>
            request.cookies.set(name, value)
          )
          supabaseResponse = NextResponse.next({ request })
          cookiesToSet.forEach(({ name, value, options }) =>
            supabaseResponse.cookies.set(name, value, options)
          )
        },
      },
    }
  )

  const { data: { user } } = await supabase.auth.getUser()

  // Redirect to /login if not authenticated on protected routes
  if (
    !user &&
   !request.nextUrl.pathname.match(/^\/(ar|en)\/(login|signup)/) &&
!request.nextUrl.pathname.startsWith('/auth') &&
request.nextUrl.pathname !== '/' &&
request.nextUrl.pathname !== '/ar' &&
request.nextUrl.pathname !== '/en'
  ) {
    const url = request.nextUrl.clone()
   const locale = request.nextUrl.pathname.split('/')[1] || 'ar'
url.pathname = `/${locale === 'en' ? 'en' : 'ar'}/login`
    return NextResponse.redirect(url)
  }

  return supabaseResponse
}