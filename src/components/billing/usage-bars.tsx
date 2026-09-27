'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { CRITICAL_AT, WARN_AT, type UsageItem } from '@/lib/types/subscription'

export function usageLevel(percentage: number | null) {
  if (percentage === null) return 'ok' as const
  if (percentage >= 100) return 'full' as const
  if (percentage >= CRITICAL_AT) return 'critical' as const
  if (percentage >= WARN_AT) return 'warning' as const
  return 'ok' as const
}

const INDICATOR = {
  ok: '',
  warning: '[&_[data-slot=progress-indicator]]:bg-amber-500',
  critical: '[&_[data-slot=progress-indicator]]:bg-orange-600',
  full: '[&_[data-slot=progress-indicator]]:bg-destructive',
}

/** One progress bar per limit, warning at 80 % and 90 %. */
export function UsageBars({ usage, compact = false }: { usage: UsageItem[]; compact?: boolean }) {
  const t = useTranslations('subscription.usage')
  const format = useFormatter()

  return (
    <div className={cn('grid gap-5', !compact && 'sm:grid-cols-2')}>
      {usage.map((item) => {
        const level = usageLevel(item.percentage)
        return (
          <div key={item.limit_type} className="grid gap-2">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{t(`types.${item.limit_type}`)}</span>
              <span className="tabular-nums text-muted-foreground">
                {item.limit === null
                  ? t('usedUnlimited', { used: format.number(item.used) })
                  : t('usedOf', { used: format.number(item.used), limit: format.number(item.limit) })}
              </span>
            </div>
            <Progress
              value={item.limit === null ? 0 : Math.min(item.percentage ?? 0, 100)}
              className={cn('h-2', INDICATOR[level])}
              aria-label={t(`types.${item.limit_type}`)}
            />
            {level !== 'ok' && (
              <p
                className={cn(
                  'flex items-center gap-1.5 text-xs',
                  level === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-destructive'
                )}
              >
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                {t(`warnings.${level}`, { percentage: format.number(Math.floor(item.percentage ?? 0)) })}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
