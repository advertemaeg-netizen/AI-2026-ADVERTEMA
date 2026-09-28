'use client'

import { useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { AlertTriangle, X } from 'lucide-react'
import { Link, usePathname } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { dismissUsageAlerts } from '@/lib/actions/subscription'
import type { UsageAlert } from '@/lib/types/subscription'

/**
 * Org admins: limits past 80 / 90 / 100 % (from usage_alerts, still true) —
 * the agency's own (clients, team) and each client's (messages, channels…) —
 * and an agency subscription that can't be used (trial over, cancelled).
 */
export function UsageBanner({
  alerts,
  inactive,
  trialDaysLeft,
}: {
  alerts: UsageAlert[]
  inactive: boolean
  trialDaysLeft: number | null
}) {
  const t = useTranslations('subscription.banner')
  const tTypes = useTranslations('subscription.usage.types')
  const format = useFormatter()
  const [isPending, startTransition] = useTransition()
  // On a phone, inside a conversation, the screen belongs to the messages
  const inThread = /^\/dashboard\/conversations\/[^/]+$/.test(usePathname())

  const showTrial = !inactive && trialDaysLeft !== null && trialDaysLeft <= 3
  if (alerts.length === 0 && !inactive && !showTrial) return null

  const worst = inactive ? 100 : Math.max(0, ...alerts.map((a) => a.threshold))
  const tone =
    inactive || worst >= 100
      ? 'border-destructive/40 bg-destructive/10 text-destructive'
      : worst >= 90
        ? 'border-orange-500/40 bg-orange-500/10 text-orange-800 dark:text-orange-300'
        : 'border-amber-500/40 bg-amber-500/10 text-amber-900 dark:text-amber-300'

  return (
    <div role="status" className={cn('flex items-start gap-3 border-b px-8 py-3 text-sm print:hidden max-md:px-4 max-md:py-2', inThread && 'max-md:hidden', tone)}>
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
      <div className="flex-1 grid gap-0.5">
        {inactive && <p className="font-medium">{t('inactive')}</p>}
        {showTrial && <p className="font-medium">{t('trialEnding', { days: trialDaysLeft })}</p>}
        {alerts.map((alert) => {
          const values = {
            limit: tTypes(alert.limit_type),
            percentage: format.number(alert.threshold),
            used: format.number(alert.used),
            max: format.number(alert.limit),
          }
          return alert.client_id ? (
            <p key={`${alert.client_id}-${alert.limit_type}`}>
              <Link href={`/dashboard/clients/${alert.client_id}/subscription`} className="font-medium underline underline-offset-4">
                {alert.client_name}
              </Link>
              {': '}
              {t(alert.threshold >= 100 ? 'full' : 'near', values)}
            </p>
          ) : (
            <p key={alert.limit_type}>{t(alert.threshold >= 100 ? 'full' : 'near', values)}</p>
          )
        })}
        {(inactive || showTrial || alerts.some((a) => !a.client_id)) && (
          <Link href="/dashboard/subscription" className="w-fit font-medium underline underline-offset-4">
            {t('manage')}
          </Link>
        )}
      </div>
      {alerts.length > 0 && (
        <Button
          variant="ghost"
          size="icon-sm"
          className="text-current hover:bg-black/5 dark:hover:bg-white/10 max-md:-my-2 max-md:-me-2 max-md:size-11"
          aria-label={t('dismiss')}
          disabled={isPending}
          onClick={() => startTransition(async () => void (await dismissUsageAlerts()))}
        >
          <X />
        </Button>
      )}
    </div>
  )
}
