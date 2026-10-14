'use client'

import { ThemeProvider } from '@/components/theme-provider'
import { Toaster } from '@/components/ui/sonner'

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    // White mode only: the palette is built and measured on the cream background
    <ThemeProvider attribute="class" forcedTheme="light" disableTransitionOnChange>
      {children}
      <Toaster />
    </ThemeProvider>
  )
}
