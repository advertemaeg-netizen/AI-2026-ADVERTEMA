'use client'

import { useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { CreditCard, Loader2, Tag } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { Progress } from '@/components/ui/progress'
import { SubscriptionStatusBadge } from '@/components/billing/status-badges'
import { usageLevel } from '@/components/billing/usage-bars'
import { useMoney } from '@/components/billing/use-money'
import { cn } from '@/lib/utils'
import {
  SUBSCRIPTION_STATUSES,
  type Plan,
  type SubscriptionRow,
  type SubscriptionStatus,
} from '@/lib/types/subscription'
import { SubscriptionActions } from '../../_components/subscription-actions'

const ALL = 'all'

export const LEVEL_CLASS = {
  ok: '',
  warning: '[&_[data-slot=progress-indicator]]:bg-amber-500',
  critical: '[&_[data-slot=progress-indicator]]:bg-orange-600',
  full: '[&_[data-slot=progress-indicator]]:bg-destructive',
}

/** Agencies' own subscriptions (agency plans paid to the platform). */
export function SubscriptionsTable({
  rows,
  plans,
  filters,
}: {
  rows: SubscriptionRow[]
  plans: Plan[]
  filters: { status?: SubscriptionStatus }
}) {
  const t = useTranslations('subscription.admin')
  const tStatus = useTranslations('subscription.status')
  const tUsage = useTranslations('subscription.usage.types')
  const locale = useLocale()
  const format = useFormatter()
  const money = useMoney()
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  function update(key: 'status', value: string) {
    const params = new URLSearchParams()
    const next: Record<string, string | undefined> = { status: filters.status }
    next[key] = value === ALL ? undefined : value
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v)
    const qs = params.toString()
    startTransition(() => router.replace(qs ? `${pathname}?${qs}` : pathname, { scroll: false }))
  }

  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'medium' })
  const basePrice = (planId: string) => plans.find((p) => p.id === planId)?.price_monthly ?? 0

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={filters.status ?? ALL} onValueChange={(v) => update('status', v)}>
          <SelectTrigger className="w-44" aria-label={t('filters.status')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{t('filters.allStatuses')}</SelectItem>
            {SUBSCRIPTION_STATUSES.map((status) => (
              <SelectItem key={status} value={status}>
                {tStatus(status)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
          <CreditCard className="size-8" />
          {t('empty')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t('columns.organization')}</TableHead>
                <TableHead>{t('columns.plan')}</TableHead>
                <TableHead className="text-end">{t('columns.price')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead className="min-w-48">{t('columns.usage')}</TableHead>
                <TableHead>{t('columns.renewal')}</TableHead>
                <TableHead className="w-12">
                  <span className="sr-only">{t('actionsLabel')}</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                // The most used limit tells the story; clients are shown too
                const limited = row.usage.filter((u) => u.limit !== null)
                const top = [...limited].sort((a, b) => (b.percentage ?? 0) - (a.percentage ?? 0))[0]
                const clients = row.usage.find((u) => u.limit_type === 'clients')
                return (
                  <TableRow key={row.subscription_id}>
                    <TableCell>
                      <Link href={`/admin/customers/${row.organization_id}`} className="font-medium hover:underline">
                        {row.organization_name}
                      </Link>
                      {!row.organization_active && (
                        <Badge variant="destructive" className="ms-2">
                          {t('orgDisabled')}
                        </Badge>
                      )}
                    </TableCell>
                    <TableCell>{locale === 'ar' ? row.plan_name_ar : row.plan_name}</TableCell>
                    <TableCell className="text-end tabular-nums">
                      {row.effective_price < row.base_price && (
                        <div className="text-xs text-muted-foreground line-through">{money.withCurrency(row.base_price)}</div>
                      )}
                      <div className="flex items-center justify-end gap-1 font-medium">
                        {row.has_custom_pricing && (
                          <Tag className="size-3.5 text-emerald-600" aria-label={t('customPrice')} />
                        )}
                        {money.withCurrency(row.effective_price)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <SubscriptionStatusBadge status={row.status} usable={row.usable} />
                    </TableCell>
                    <TableCell>
                      <div className="grid gap-1.5 text-xs">
                        {clients && (
                          <div className="flex justify-between gap-2 tabular-nums">
                            <span className="text-muted-foreground">{tUsage('clients')}</span>
                            <span>
                              {format.number(clients.used)}
                              {clients.limit !== null && ` / ${format.number(clients.limit)}`}
                            </span>
                          </div>
                        )}
                        {top && (
                          <>
                            <Progress
                              value={Math.min(top.percentage ?? 0, 100)}
                              className={cn('h-1.5', LEVEL_CLASS[usageLevel(top.percentage)])}
                              aria-label={tUsage(top.limit_type)}
                            />
                            <span className="text-muted-foreground">
                              {t('topUsage', {
                                limit: tUsage(top.limit_type),
                                percentage: format.number(Math.floor(top.percentage ?? 0)),
                              })}
                            </span>
                          </>
                        )}
                      </div>
                    </TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {row.status === 'trialing' && row.trial_ends_at
                        ? t('trialUntil', { date: date(row.trial_ends_at) })
                        : date(row.current_period_end)}
                    </TableCell>
                    <TableCell>
                      <SubscriptionActions
                        plans={plans}
                        target={{
                          organizationId: row.organization_id,
                          organizationName: row.organization_name,
                          planId: row.plan_id,
                          status: row.status,
                          notes: null,
                          hasCustomPricing: row.has_custom_pricing,
                          basePrice: basePrice(row.plan_id),
                        }}
                      />
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  )
}
