'use client'

import { useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Download, Loader2, Printer } from 'lucide-react'
import { usePathname, useRouter } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { DateRangeTabs, fromDateKey } from '@/components/date-range-tabs'
import { exportAnalyticsCSV } from '@/lib/actions/analytics'
import { cn } from '@/lib/utils'
import { ANALYTICS_PRESETS, type AnalyticsData } from '@/lib/types/analytics'
import { KpiCards } from './kpi-cards'
import { useFormatDuration } from './use-format-duration'
import { ChannelsChart, FunnelChart, LeadStatusChart, OverTimeChart, PeakHoursChart } from './charts'

const fromKey = fromDateKey

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
  const router = useRouter()
  const pathname = usePathname()
  const formatDuration = useFormatDuration()
  const [isPending, startTransition] = useTransition()
  const [isExporting, startExporting] = useTransition()

  const { range } = data

  function navigate(query: Record<string, string>) {
    const params = new URLSearchParams(query).toString()
    startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }))
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
        <DateRangeTabs
          range={range}
          presets={ANALYTICS_PRESETS.filter((p) => p !== 'custom')}
          onNavigate={navigate}
        />

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
