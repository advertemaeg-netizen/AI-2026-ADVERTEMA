'use client'

import { useEffect } from 'react'
import { useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'

/**
 * Fallback for the error.tsx boundaries: a translated message, a retry and a
 * way back. In production Next.js hides server error messages; the digest
 * matches the server log entry, so it's shown for support.
 */
export function RouteError({
  error,
  retry,
  showDashboardLink = true,
}: {
  error: Error & { digest?: string }
  retry: () => void
  showDashboardLink?: boolean
}) {
  const t = useTranslations('errorPage')

  useEffect(() => {
    console.error(error)
  }, [error])

  return (
    <div role="alert" className="flex min-h-[60vh] flex-col items-center justify-center gap-4 p-8 text-center">
      <AlertTriangle className="size-10 text-destructive" aria-hidden />
      <div className="grid gap-1.5">
        <h1 className="text-2xl font-bold tracking-tight">{t('title')}</h1>
        <p className="max-w-md text-muted-foreground">{t('description')}</p>
        {error.digest && (
          <p className="text-xs text-muted-foreground" dir="ltr">
            {t('reference', { digest: error.digest })}
          </p>
        )}
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button onClick={() => retry()}>{t('retry')}</Button>
        {showDashboardLink && (
          <Button variant="outline" asChild>
            <Link href="/dashboard">{t('backToDashboard')}</Link>
          </Button>
        )}
      </div>
    </div>
  )
}
