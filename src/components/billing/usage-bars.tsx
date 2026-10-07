'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { AlertTriangle } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { cn } from '@/lib/utils'
import { CRITICAL_AT, WARN_AT, leadCaptureRemaining, type UsageItem } from '@/lib/types/subscription'

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
export function UsageBars({
  usage,
  compact = false,
  rawKnowledge = false,
}: {
  usage: UsageItem[]
  compact?: boolean
  /** Support views: the knowledge base's chunk counts next to the percentage */
  rawKnowledge?: boolean
}) {
  const t = useTranslations('subscription.usage')
  const tChunks = useTranslations('knowledgeLimits')
  const format = useFormatter()

  return (
    <div className={cn('grid gap-5', !compact && 'sm:grid-cols-2')}>
      {usage.map((item) => {
        const level = usageLevel(item.percentage)
        // At the message limit the bot is silent, but leads are still captured for a while
        const captureLeft =
          item.limit !== null && item.used >= item.limit && item.lead_capture_used !== undefined
            ? leadCaptureRemaining(item.limit, item.lead_capture_used)
            : null
        // Chunks mean nothing to a clinic owner: the knowledge base reads as space used
        const isSpace = item.limit_type === 'knowledge_chunks'
        const label = isSpace ? tChunks('space') : t(`types.${item.limit_type}`)
        // Rounded, but never 100 % before the limit is really reached
        const percentUsed = (item.percentage ?? 0) >= 100 ? 100 : Math.min(Math.round(item.percentage ?? 0), 99)
        const used = format.number(item.used)
        const limit = item.limit === null ? null : format.number(item.limit)
        const percentage = format.number(percentUsed)
        let value: string
        if (!isSpace) value = limit === null ? t('usedUnlimited', { used }) : t('usedOf', { used, limit })
        else if (rawKnowledge) {
          value = limit === null ? t('usedUnlimited', { used }) : tChunks('usedOfPercent', { used, limit, percentage })
        } else value = limit === null ? tChunks('unlimited') : tChunks('usedPercent', { percentage })
        return (
          <div key={item.limit_type} className="grid gap-2">
            <div className="flex items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{label}</span>
              <span className="tabular-nums text-muted-foreground">
                {value}
              </span>
            </div>
            <Progress
              value={item.limit === null ? 0 : Math.min(item.percentage ?? 0, 100)}
              className={cn('h-2', INDICATOR[level])}
              aria-label={label}
            />
            {level !== 'ok' && (
              <p
                className={cn(
                  'flex items-center gap-1.5 text-xs',
                  level === 'warning' ? 'text-amber-700 dark:text-amber-400' : 'text-destructive'
                )}
              >
                <AlertTriangle className="size-3.5 shrink-0" aria-hidden />
                {captureLeft === null
                  ? t(`warnings.${level}`, { percentage: format.number(Math.floor(item.percentage ?? 0)) })
                  : captureLeft > 0
                    ? t('leadCapture', { count: captureLeft })
                    : t('leadCaptureStopped')}
              </p>
            )}
          </div>
        )
      })}
    </div>
  )
}
