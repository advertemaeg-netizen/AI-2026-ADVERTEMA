import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { Readex_Pro } from 'next/font/google'
import { Providers } from '@/components/providers'
import { routing } from '@/i18n/routing'
import '../globals.css'

// Readex Pro, Arabic first with a Latin companion drawn to match it, in one
// variable family (10 November 2026, the comments tab decisions 7.2; it
// replaces Alexandria). One face carries both scripts, so its fallback only
// shows while the font loads. Only what is used is loaded: the two subsets
// the product writes in, and the variable weight axis alone (no HEXP axis).
// The product uses 400, 500, 600 and 700; as statics those are four files per
// subset, as the variable font one, so the axis is the lighter load.
const readex = Readex_Pro({ subsets: ['arabic', 'latin'] })
const fontStack = readex.style.fontFamily

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