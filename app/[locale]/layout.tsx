import type { Metadata, Viewport } from 'next'
import { NextIntlClientProvider, hasLocale } from 'next-intl'
import { setRequestLocale } from 'next-intl/server'
import { notFound } from 'next/navigation'
import { Cairo } from 'next/font/google'
import { Providers } from '@/components/providers'
import { MARK_SEEN_SCRIPT } from '@/components/brand'
import { routing } from '@/i18n/routing'
import '../globals.css'

const cairo = Cairo({
  subsets: ['arabic', 'latin'],
  variable: '--font-cairo',
})

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
      <head>
        <script dangerouslySetInnerHTML={{ __html: MARK_SEEN_SCRIPT }} />
      </head>
      <body className={`${cairo.variable} font-sans antialiased`} suppressHydrationWarning>
        <NextIntlClientProvider>
          <Providers>{children}</Providers>
        </NextIntlClientProvider>
      </body>
    </html>
  )
}