'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { ar, enUS } from 'react-day-picker/locale'
import type { DateRange } from 'react-day-picker'
import { CalendarRange } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { cairoParts } from '@/lib/cairo-time'
import type { AnalyticsPreset, AnalyticsRange } from '@/lib/types/analytics'

const toKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
export const fromDateKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

/**
 * Preset periods plus a custom range picker (Cairo dates), for pages whose
 * period lives in the URL (?range=7d, ?range=custom&from=&to=; see
 * parseAnalyticsRange). `onNavigate` gets the new query.
 */
export function DateRangeTabs({
  range,
  presets,
  onNavigate,
}: {
  range: Pick<AnalyticsRange, 'preset' | 'fromDate' | 'toDate'>
  /** Shown before "custom" */
  presets: readonly Exclude<AnalyticsPreset, 'custom'>[]
  onNavigate: (query: Record<string, string>) => void
}) {
  const t = useTranslations('analytics')
  const locale = useLocale()
  const [customOpen, setCustomOpen] = useState(false)
  const [custom, setCustom] = useState<DateRange | undefined>({
    from: fromDateKey(range.fromDate),
    to: fromDateKey(range.toDate),
  })
  const today = cairoParts(new Date())

  function applyCustom() {
    if (!custom?.from) return
    onNavigate({ range: 'custom', from: toKey(custom.from), to: toKey(custom.to ?? custom.from) })
    setCustomOpen(false)
  }

  return (
    <Tabs value={range.preset} onValueChange={(value) => value !== 'custom' && onNavigate({ range: value })}>
      <TabsList>
        {presets.map((preset) => (
          <TabsTrigger key={preset} value={preset}>
            {t(`ranges.${preset}`)}
          </TabsTrigger>
        ))}
        <Popover open={customOpen} onOpenChange={setCustomOpen}>
          <PopoverTrigger asChild>
            <TabsTrigger value="custom" onClick={() => setCustomOpen(true)}>
              <CalendarRange data-icon="inline-start" />
              {t('ranges.custom')}
            </TabsTrigger>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-2" align="start">
            <Calendar
              mode="range"
              selected={custom}
              onSelect={setCustom}
              numberOfMonths={2}
              locale={locale === 'ar' ? ar : enUS}
              dir={locale === 'ar' ? 'rtl' : 'ltr'}
              disabled={{ after: new Date(today.year, today.month, today.day) }}
            />
            <div className="flex justify-end border-t p-2">
              <Button size="sm" onClick={applyCustom} disabled={!custom?.from}>
                {t('apply')}
              </Button>
            </div>
          </PopoverContent>
        </Popover>
      </TabsList>
    </Tabs>
  )
}
