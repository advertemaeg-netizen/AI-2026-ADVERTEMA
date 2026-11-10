'use client'

import { useLocale } from 'next-intl'
import { Direction } from 'radix-ui'
import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'

export function Providers({ children }: { children: React.ReactNode }) {
  // Radix reads direction from its own context, not from <html dir>: without
  // this every select, menu and tab list rendered dir="ltr" in Arabic, and a
  // select clipped an Arabic value from its start (the sidebar's client name,
  // "ـب الأسنان — حساب تجريبي", 2026-11-10)
  const dir = useLocale() === 'ar' ? 'rtl' : 'ltr'
  return (
    <Direction.DirectionProvider dir={dir}>
      {/* White mode only: the palette is built and measured on the cream background */}
      <ThemeProvider attribute="class" forcedTheme="light" disableTransitionOnChange>
        {children}
        <Toaster />
      </ThemeProvider>
    </Direction.DirectionProvider>
  )
}
