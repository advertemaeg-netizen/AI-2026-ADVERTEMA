import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { IBM_Plex_Sans_Arabic, Manrope } from 'next/font/google'
import { Providers } from '@/components/providers'
import { routing } from '@/i18n/routing'
import '../globals.css'

// Brand v2 (22 October 2026): Manrope for Latin, IBM Plex Sans Arabic for Arabic,
// only the weights the guidelines list (800 is the logo, which is a file).
const manrope = Manrope({
  subsets: ['latin'],
  weight: ['400', '500', '600', '700'],
})
const plexArabic = IBM_Plex_Sans_Arabic({
  subsets: ['arabic'],
  weight: ['400', '500', '600', '700'],
})

// Both web fonts before either fallback. next/font pairs each face with an
// Arial-based fallback ("Manrope", "Manrope Fallback"); Arial has Arabic
// glyphs, so in that order it catches every Arabic letter before Plex is
// reached (seen in Chrome's platform-font report on 23 October 2026; a machine
// without Arial hides it). adjustFontFallback: false does not remove it under
// Turbopack, so the stack is rebuilt from next/font's own names, whatever
// they are called in a build: web fonts first, fallbacks after.
const [manropeFace, ...manropeFallbacks] = manrope.style.fontFamily.split(', ')
const [plexFace, ...plexFallbacks] = plexArabic.style.fontFamily.split(', ')
const fontStack = [manropeFace, plexFace, ...manropeFallbacks, ...plexFallbacks].join(', ')

// cover: env(safe-area-inset-*) is only non-zero with it (notch, home indicator).
// resizes-content: on Android the layout shrinks above the keyboard, so a
// conversation's reply box stays visible while typing.
export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  viewportFit: 'cover',
  interactiveWidget: 'resizes-content',
}

export const metadata: Metadata = {
  title: 'Mudrik AI',
  description: 'AI-powered multi-channel conversation management',
  // The logo's own M, cropped from public/brand/mudrik-logo.svg (the wordmark is illegible at 16px):
  // charcoal, white in a dark tab. app/favicon.ico is the same M, for browsers without SVG icons
  icons: { icon: [{ url: '/brand/mudrik-favicon.svg', type: 'image/svg+xml' }] },
}

export default async function LocaleLayout({
  children,
  params,
}: {
  children: React.ReactNode
  params: Promise<{ locale: string }>
}) {
  const { locale } = await params

  if (!hasLocale(routing.locales, locale)) {
    notFound()
  }
  // Without it next-intl reads the locale from the request, and the
  // marketing site under ./site could not be rendered at build time
  setRequestLocale(locale)

  return (
    <html
      lang={locale}
      dir={locale === 'ar' ? 'rtl' : 'ltr'}
      suppressHydrationWarning
    >
      <body
        className="font-sans antialiased"
        style={{ '--font-stack': fontStack } as React.CSSProperties}
        suppressHydrationWarning
      >
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}