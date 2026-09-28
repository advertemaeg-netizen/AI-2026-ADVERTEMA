'use client'

import { useTransition } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { AlertTriangle, Coins, Download, Loader2, Sigma, TrendingDown, Wallet, type LucideIcon } from 'lucide-react'
import { Link, usePathname, useRouter } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { DateRangeTabs, fromDateKey } from '@/components/date-range-tabs'
import { useMoney } from '@/components/billing/use-money'
import { cn } from '@/lib/utils'
import { LOW_MARGIN_PCT, type AiUsageClientSummary, type AiUsageOverview } from '@/lib/types/ai-usage'
import type { AnalyticsRange } from '@/lib/types/analytics'
import { ExchangeRateButton } from './exchange-rate-button'
import { ModelPricingCard } from './model-pricing-card'
import { ltr } from './ltr'

/** USD with enough decimals for fractions of a cent */
export function useUsd() {
  const format = useFormatter()
  return (value: number) =>
    ltr(format.number(value, {
      style: 'currency',
      currency: 'USD',
      minimumFractionDigits: 2,
      maximumFractionDigits: value !== 0 && Math.abs(value) < 1 ? 4 : 2,
    }))
}

function downloadCsv(filename: string, rows: (string | number | null)[][]) {
  const escape = (value: string | number | null) => {
    const text = value === null ? '' : String(value)
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }
  // BOM so Excel reads the Arabic names as UTF-8
  const csv = '﻿' + rows.map((row) => row.map(escape).join(',')).join('\n')
  const link = document.createElement('a')
  link.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }))
  link.download = filename
  link.click()
  URL.revokeObjectURL(link.href)
}

export function AiUsageDashboard({ overview, range }: { overview: AiUsageOverview; range: AnalyticsRange }) {
  const t = useTranslations('aiUsage')
  const format = useFormatter()
  const locale = useLocale()
  const money = useMoney()
  const usd = useUsd()
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  const { totals, clients, operations, plans } = overview
  const negative = clients.filter((c) => c.flag === 'negative').length
  const low = clients.filter((c) => c.flag === 'low').length
  const planName = (row: { plan_name: string | null; plan_name_ar: string | null }) =>
    (locale === 'ar' ? row.plan_name_ar : row.plan_name) ?? t('clients.noPlan')
  const period = `${format.dateTime(fromDateKey(range.fromDate), { dateStyle: 'medium' })} – ${format.dateTime(
    fromDateKey(range.toDate),
    { dateStyle: 'medium' }
  )}`

  function navigate(query: Record<string, string>) {
    const params = new URLSearchParams(query).toString()
    startTransition(() => router.replace(`${pathname}?${params}`, { scroll: false }))
  }

  function exportCsv() {
    downloadCsv(`ai-usage-${range.fromDate}_${range.toDate}.csv`, [
      [
        t('csv.client'),
        t('csv.organization'),
        t('csv.type'),
        t('csv.plan'),
        t('csv.requests'),
        t('csv.promptTokens'),
        t('csv.completionTokens'),
        t('csv.totalTokens'),
        t('csv.costUsd'),
        t('csv.costEgp'),
        t('csv.value'),
        t('csv.margin'),
        t('csv.marginPct'),
      ],
      ...clients.map((c) => [
        c.client_name,
        c.organization_name,
        t(`types.${c.org_type}`),
        c.plan_slug ?? '',
        c.requests,
        c.prompt_tokens,
        c.completion_tokens,
        c.total_tokens,
        c.cost_usd.toFixed(6),
        c.cost_egp.toFixed(2),
        c.value_egp?.toFixed(2) ?? '',
        c.margin_egp?.toFixed(2) ?? '',
        c.margin_pct?.toFixed(1) ?? '',
      ]),
    ])
  }

  const kpis: { key: string; icon: LucideIcon; value: string; hint: string; tone?: 'bad' }[] = [
    {
      key: 'tokens',
      icon: Sigma,
      value: format.number(totals.total_tokens),
      hint: t('kpis.requests', { count: totals.requests }),
    },
    { key: 'costUsd', icon: Coins, value: usd(totals.cost_usd), hint: t('kpis.costUsdHint') },
    {
      key: 'costEgp',
      icon: Wallet,
      value: money.withCurrency(totals.cost_egp),
      hint: t('kpis.rate', { rate: format.number(overview.usdToEgp) }),
    },
    {
      key: 'atRisk',
      icon: TrendingDown,
      value: format.number(negative + low),
      hint: t('kpis.atRiskHint', { negative, low, threshold: LOW_MARGIN_PCT }),
      tone: negative + low > 0 ? 'bad' : undefined,
    },
  ]

  return (
    <div className="grid gap-6">
      {/* One filter row scoping everything below it */}
      <div className="flex flex-wrap items-center gap-2">
        <DateRangeTabs range={range} presets={['today', '7d', '30d']} onNavigate={navigate} />
        {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-label={t('loading')} />}
        <div className="ms-auto flex flex-wrap gap-2">
          <ExchangeRateButton rate={overview.usdToEgp} />
          <Button variant="outline" size="sm" onClick={exportCsv} disabled={clients.length === 0}>
            <Download data-icon="inline-start" />
            {t('exportCsv')}
          </Button>
        </div>
      </div>
      <p className="-mt-3 text-sm text-muted-foreground">{period}</p>

      <div className={cn('grid gap-6 transition-opacity', isPending && 'pointer-events-none opacity-60')}>
        <div className="grid grid-cols-2 gap-4 xl:grid-cols-4">
          {kpis.map(({ key, icon: Icon, value, hint, tone }) => (
            <Card key={key} size="sm">
              <CardHeader className="flex flex-row items-center justify-between gap-2">
                <CardTitle className="text-sm font-medium text-muted-foreground">{t(`kpis.${key}`)}</CardTitle>
                <Icon className="size-4 text-muted-foreground" aria-hidden />
              </CardHeader>
              <CardContent className="grid gap-1">
                <div className={cn('text-2xl font-semibold tabular-nums', tone === 'bad' && 'text-destructive')}>{value}</div>
                <p className="text-xs text-muted-foreground">{hint}</p>
              </CardContent>
            </Card>
          ))}
        </div>

        {overview.unpriced.length > 0 && (
          <div
            role="status"
            className="flex items-start gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-4 text-sm"
          >
            <AlertTriangle className="mt-0.5 size-4 shrink-0 text-amber-600" aria-hidden />
            <div className="grid gap-1">
              <p className="font-medium">{t('unpriced.title')}</p>
              <p className="text-muted-foreground">{t('unpriced.description')}</p>
              <ul className="flex flex-wrap gap-2 pt-1">
                {overview.unpriced.map((m) => (
                  <li key={m.model}>
                    <Badge variant="outline" dir="ltr">
                      {m.model} · {format.number(m.requests)}
                    </Badge>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}

        <div className="grid gap-6 2xl:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>{t('operations.title')}</CardTitle>
              <CardDescription>{t('operations.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {operations.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
              ) : (
                <ul className="grid gap-4">
                  {operations.map((op) => {
                    const share = totals.cost_usd > 0 ? op.cost_usd / totals.cost_usd : 0
                    return (
                      <li key={op.operation} className="grid gap-1.5">
                        <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
                          <span className="font-medium">{t(`operations.names.${op.operation}`)}</span>
                          <span className="tabular-nums text-muted-foreground">
                            {usd(op.cost_usd)} · {format.number(share, { style: 'percent', maximumFractionDigits: 0 })}
                          </span>
                        </div>
                        <div className="h-2 rounded-full bg-muted" aria-hidden>
                          <div className="h-2 rounded-full bg-primary" style={{ width: `${Math.max(share * 100, 1)}%` }} />
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {t('operations.detail', {
                            requests: op.requests,
                            tokens: format.number(op.total_tokens),
                          })}
                        </p>
                      </li>
                    )
                  })}
                </ul>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>{t('plans.title')}</CardTitle>
              <CardDescription>{t('plans.description')}</CardDescription>
            </CardHeader>
            <CardContent>
              {plans.length === 0 ? (
                <p className="py-6 text-center text-sm text-muted-foreground">{t('empty')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t('plans.columns.plan')}</TableHead>
                        <TableHead className="text-end">{t('plans.columns.clients')}</TableHead>
                        <TableHead className="text-end">{t('plans.columns.avgMonthly')}</TableHead>
                        <TableHead className="text-end">{t('plans.columns.price')}</TableHead>
                        <TableHead className="text-end">{t('plans.columns.margin')}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {plans.map((plan) => (
                        <TableRow key={plan.plan_slug ?? 'none'}>
                          <TableCell className="font-medium">{planName(plan)}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {t('plans.clientsValue', { active: plan.active_clients, total: plan.clients })}
                          </TableCell>
                          <TableCell className="text-end tabular-nums">{money.withCurrency(plan.avg_monthly_cost_egp)}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {plan.avg_monthly_price === null ? '—' : money.withCurrency(plan.avg_monthly_price)}
                          </TableCell>
                          <TableCell
                            className={cn(
                              'text-end tabular-nums',
                              plan.avg_margin_pct !== null && plan.avg_margin_pct < LOW_MARGIN_PCT && 'text-destructive'
                            )}
                          >
                            {plan.avg_margin_pct === null ? '—' : format.number(plan.avg_margin_pct / 100, { style: 'percent', maximumFractionDigits: 1 })}
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        <ClientsCard clients={clients} planName={planName} />
      </div>

      <ModelPricingCard models={overview.models} />
    </div>
  )
}

function ClientsCard({
  clients,
  planName,
}: {
  clients: AiUsageClientSummary[]
  planName: (row: { plan_name: string | null; plan_name_ar: string | null }) => string
}) {
  const t = useTranslations('aiUsage')
  const format = useFormatter()
  const money = useMoney()
  const usd = useUsd()

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('clients.title')}</CardTitle>
        <CardDescription>{t('clients.description', { threshold: LOW_MARGIN_PCT })}</CardDescription>
      </CardHeader>
      <CardContent>
        {clients.length === 0 ? (
          <p className="py-6 text-center text-sm text-muted-foreground">{t('clients.empty')}</p>
        ) : (
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t('clients.columns.client')}</TableHead>
                  <TableHead>{t('clients.columns.plan')}</TableHead>
                  <TableHead className="text-end">{t('clients.columns.tokens')}</TableHead>
                  <TableHead className="text-end">{t('clients.columns.costUsd')}</TableHead>
                  <TableHead className="text-end">{t('clients.columns.costEgp')}</TableHead>
                  <TableHead className="text-end">{t('clients.columns.value')}</TableHead>
                  <TableHead className="text-end">{t('clients.columns.margin')}</TableHead>
                  <TableHead className="text-end">{t('clients.columns.marginPct')}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {clients.map((c) => (
                  <TableRow
                    key={c.client_id}
                    className={cn(
                      c.flag === 'negative' && 'bg-destructive/5 hover:bg-destructive/10',
                      c.flag === 'low' && 'bg-amber-500/5 hover:bg-amber-500/10'
                    )}
                  >
                    <TableCell>
                      <Link href={`/admin/customers/${c.organization_id}`} className="font-medium hover:underline">
                        {c.client_name}
                      </Link>
                      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
                        {c.org_type === 'direct' ? (
                          <Badge variant="secondary" className="px-1.5 py-0 text-[11px]">
                            {t('types.direct')}
                          </Badge>
                        ) : (
                          c.organization_name
                        )}
                        {c.flag && (
                          <span
                            className={cn(
                              'inline-flex items-center gap-1',
                              c.flag === 'negative' ? 'text-destructive' : 'text-amber-700 dark:text-amber-400'
                            )}
                          >
                            <AlertTriangle className="size-3" aria-hidden />
                            {t(`clients.flags.${c.flag}`, { threshold: LOW_MARGIN_PCT })}
                          </span>
                        )}
                        {c.cost_alert && <span className="text-destructive">{t('clients.flags.alert')}</span>}
                      </div>
                    </TableCell>
                    <TableCell className="text-muted-foreground">{c.plan_slug ? planName(c) : t('clients.noPlan')}</TableCell>
                    <TableCell className="text-end tabular-nums">{format.number(c.total_tokens)}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {usd(c.cost_usd)}
                      {c.unpriced_requests > 0 && (
                        <span className="block text-xs text-amber-700 dark:text-amber-400">
                          {t('clients.unpriced', { count: c.unpriced_requests })}
                        </span>
                      )}
                    </TableCell>
                    <TableCell className="text-end tabular-nums">{money.withCurrency(c.cost_egp)}</TableCell>
                    <TableCell className="text-end tabular-nums text-muted-foreground">
                      {c.value_egp === null ? '—' : money.withCurrency(c.value_egp)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-end font-medium tabular-nums',
                        c.margin_egp !== null && c.margin_egp < 0 && 'text-destructive'
                      )}
                    >
                      {c.margin_egp === null ? '—' : money.withCurrency(c.margin_egp)}
                    </TableCell>
                    <TableCell
                      className={cn(
                        'text-end tabular-nums',
                        c.flag === 'negative' && 'text-destructive',
                        c.flag === 'low' && 'text-amber-700 dark:text-amber-400'
                      )}
                    >
                      {c.margin_pct === null
                        ? '—'
                        : format.number(c.margin_pct / 100, { style: 'percent', maximumFractionDigits: 1, signDisplay: 'negative' })}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
