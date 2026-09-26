'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { ArrowDownRight, ArrowUpRight, Minus } from 'lucide-react'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import type { Kpis } from '@/lib/types/analytics'
import { useFormatDuration } from './use-format-duration'

type KpiKey = keyof Kpis

// Rates compare in percentage points; counts and times in percent
const RATE_KEYS: KpiKey[] = ['conversionRate', 'attendanceRate']
// For these a drop is the good direction
const LOWER_IS_BETTER: KpiKey[] = ['avgResponseSeconds']

const ORDER: { key: KpiKey; label: string }[] = [
  { key: 'conversations', label: 'conversations' },
  { key: 'leads', label: 'leads' },
  { key: 'conversionRate', label: 'conversionRate' },
  { key: 'avgResponseSeconds', label: 'responseTime' },
  { key: 'booked', label: 'booked' },
  { key: 'attendanceRate', label: 'attendanceRate' },
]

export function KpiCards({ current, previous }: { current: Kpis; previous: Kpis }) {
  const t = useTranslations('analytics')
  const format = useFormatter()
  const formatDuration = useFormatDuration()

  function display(key: KpiKey, value: number | null) {
    if (value === null) return '—'
    if (RATE_KEYS.includes(key)) return format.number(value, { style: 'percent', maximumFractionDigits: 1 })
    if (key === 'avgResponseSeconds') return formatDuration(value)
    return format.number(value)
  }

  function delta(key: KpiKey) {
    const now = current[key]
    const before = previous[key]
    if (now === null || before === null) return null
    if (RATE_KEYS.includes(key)) {
      const points = (now - before) * 100
      return { change: points, text: t('delta.points', { value: format.number(Math.abs(points), { maximumFractionDigits: 1 }) }) }
    }
    if (before === 0) return null
    const change = (now - before) / before
    return {
      change,
      text: format.number(Math.abs(change), { style: 'percent', maximumFractionDigits: 0 }),
    }
  }

  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6">
      {ORDER.map(({ key, label }) => {
        const d = delta(key)
        const flat = !d || Math.abs(d.change) < 0.0005
        const good = d && !flat && (LOWER_IS_BETTER.includes(key) ? d.change < 0 : d.change > 0)
        const Icon = flat ? Minus : d!.change > 0 ? ArrowUpRight : ArrowDownRight
        return (
          <Card key={key} size="sm" className="break-inside-avoid">
            <CardHeader>
              <CardTitle className="text-sm font-medium text-muted-foreground">{t(`kpis.${label}`)}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-1">
              <div className="text-2xl font-semibold">{display(key, current[key])}</div>
              <p
                className={cn(
                  'flex items-center gap-1 text-xs',
                  !d || flat ? 'text-muted-foreground' : good ? 'text-emerald-700 dark:text-emerald-400' : 'text-destructive'
                )}
              >
                {d ? (
                  <>
                    <Icon className="size-3.5 shrink-0" aria-hidden />
                    <span>
                      {flat ? t('delta.same') : t(d.change > 0 ? 'delta.up' : 'delta.down', { value: d.text })}
                    </span>
                  </>
                ) : (
                  <span>{t('delta.none')}</span>
                )}
              </p>
            </CardContent>
          </Card>
        )
      })}
    </div>
  )
}
