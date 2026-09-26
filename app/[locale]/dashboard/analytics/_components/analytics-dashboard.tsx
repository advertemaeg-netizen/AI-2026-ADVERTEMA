'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ar, enUS } from 'react-day-picker/locale'
import type { DateRange } from 'react-day-picker'
import { CalendarRange, Download, Loader2, Printer } from 'lucide-react'
import { usePathname, useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { exportAnalyticsCSV } from '@/lib/actions/analytics'
import { cairoParts } from '@/lib/cairo-time'
import { cn } from '@/lib/utils'
import { ANALYTICS_PRESETS, type AnalyticsData } from '@/lib/types/analytics'
import { KpiCards } from './kpi-cards'
import { useFormatDuration } from './use-format-duration'
import { ChannelsChart, FunnelChart, LeadStatusChart, OverTimeChart, PeakHoursChart } from './charts'

const toKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
const fromKey = (key: string) => {
  const [y, m, d] = key.split('-').map(Number)
  return new Date(y, m - 1, d)
}

export function AnalyticsDashboard({
  data,
  clientId,
  scopeName,
}: {
  data: AnalyticsData
  clientId: string | null
  scopeName: string
}) {
  const t = useTranslations('analytics')
  const format = useFormatter()
  const locale = useLocale()
  const router = useRouter()
  const pathname = usePathname()
  const formatDuration = useFormatDuration()
  const [isPending, startTransition] = useTransition()
  const [isExporting, startExporting] = useTransition()
  const [customOpen, setCustomOpen] = useState(false)
  const [custom, setCustom] = useState<DateRange | undefined>({
    from: fromKey(data.range.fromDate),
    to: fromKey(data.range.toDate),
  })

  const { range } = data
  const today = cairoParts(new Date())

  function navigate(query: Record<string, string>) {
    const params = new URLSearchParams(query).toString()
    startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }))
  }

  function applyCustom() {
    if (!custom?.from) return
    navigate({ range: 'custom', from: toKey(custom.from), to: toKey(custom.to ?? custom.from) })
    setCustomOpen(false)
  }

  function exportCsv() {
    startExporting(async () => {
      const result = await exportAnalyticsCSV(clientId, range)
      if (!result.ok) {
        toast.error(t('errors.export'))
        return
      }
      const url = URL.createObjectURL(new Blob([result.csv], { type: 'text/csv;charset=utf-8' }))
      const link = document.createElement('a')
      link.href = url
      link.download = `analytics-${range.fromDate}_${range.toDate}.csv`
      link.click()
      URL.revokeObjectURL(url)
    })
  }

  const period = `${format.dateTime(fromKey(range.fromDate), { dateStyle: 'medium' })} – ${format.dateTime(
    fromKey(range.toDate),
    { dateStyle: 'medium' }
  )}`

  return (
    <div className="grid gap-6 print:block print:*:mb-6">
      {/* One filter row scoping everything below it */}
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <Tabs
          value={range.preset}
          onValueChange={(value) => value !== 'custom' && navigate({ range: value })}
        >
          <TabsList>
            {ANALYTICS_PRESETS.filter((p) => p !== 'custom').map((preset) => (
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

        {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('loading')} />}

        <div className="ms-auto flex gap-2">
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={isExporting}>
            {isExporting ? <Loader2 data-icon="inline-start" className="animate-spin" /> : <Download data-icon="inline-start" />}
            {t('exportCsv')}
          </Button>
          <Button variant="outline" size="sm" onClick={() => window.print()}>
            <Printer data-icon="inline-start" />
            {t('exportPdf')}
          </Button>
        </div>
      </div>

      <p className="text-sm text-muted-foreground">
        {scopeName} · {period}
        {' · '}
        {t('comparedTo', {
          period: `${format.dateTime(new Date(data.previous.from), { dateStyle: 'medium' })} – ${format.dateTime(
            new Date(new Date(data.previous.to).getTime() - 1),
            { dateStyle: 'medium' }
          )}`,
        })}
      </p>

      {/* While a new range loads, keep the current render, dimmed */}
      {/* print:block — Chromium overlaps grid items that split across printed pages */}
      <div
        className={cn(
          'grid gap-6 transition-opacity print:block print:*:mb-6',
          isPending && 'pointer-events-none opacity-60'
        )}
      >
        <KpiCards current={data.kpis.current} previous={data.kpis.previous} />

        <OverTimeChart data={data} />

        <div className="grid gap-6 lg:grid-cols-2 print:block print:*:mb-6">
          <FunnelChart data={data} />
          <ChannelsChart data={data} />
          <PeakHoursChart data={data} />
          <LeadStatusChart data={data} />
        </div>

        {data.response.agentResponded > 0 && (
          <p className="text-xs text-muted-foreground">
            {t('agentResponse', {
              count: data.response.agentResponded,
              time: data.response.agentAvgSeconds === null ? '—' : formatDuration(data.response.agentAvgSeconds),
            })}
          </p>
        )}

        {data.topClients && <TopClients clients={data.topClients} />}
      </div>
    </div>
  )
}

function TopClients({ clients }: { clients: NonNullable<AnalyticsData['topClients']> }) {
  const t = useTranslations('analytics')
  const format = useFormatter()
  const pct = (value: number | null) =>
    value === null ? '—' : format.number(value, { style: 'percent', maximumFractionDigits: 1 })

  return (
    <Card className="break-inside-avoid">
      <CardHeader>
        <CardTitle>{t('topClients.title')}</CardTitle>
        <CardDescription>{t('topClients.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        {clients.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('noData')}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b text-muted-foreground">
                  <th className="py-2 text-start font-medium">{t('topClients.client')}</th>
                  <th className="py-2 text-start font-medium">{t('series.conversations')}</th>
                  <th className="py-2 text-start font-medium">{t('series.leads')}</th>
                  <th className="py-2 text-start font-medium">{t('kpis.conversionRate')}</th>
                  <th className="py-2 text-start font-medium">{t('kpis.booked')}</th>
                  <th className="py-2 text-start font-medium">{t('kpis.attendanceRate')}</th>
                </tr>
              </thead>
              <tbody className="tabular-nums">
                {clients.map((client) => (
                  <tr key={client.clientId} className="border-b last:border-0">
                    <td className="py-2 font-medium">{client.clientName}</td>
                    <td className="py-2">{format.number(client.conversations)}</td>
                    <td className="py-2">{format.number(client.leads)}</td>
                    <td className="py-2">{pct(client.conversionRate)}</td>
                    <td className="py-2">{format.number(client.booked)}</td>
                    <td className="py-2">{pct(client.attendanceRate)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
