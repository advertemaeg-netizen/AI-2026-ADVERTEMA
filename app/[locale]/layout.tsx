import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { Alexandria } from 'next/font/google'
import { Providers } from '@/components/providers'
import { routing } from '@/i18n/routing'
import '../globals.css'

// Alexandria, Arabic and Latin in one variable family (100–900). Back on
// 25 October 2026 by the owner's choice, replacing Manrope + IBM Plex Sans
// Arabic. One face carries both scripts, so its Arial fallback only shows
// while the font loads: there is no second web font for it to get in front of.
const alexandria = Alexandria({ subsets: ['arabic', 'latin'] })
const fontStack = alexandria.style.fontFamily

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