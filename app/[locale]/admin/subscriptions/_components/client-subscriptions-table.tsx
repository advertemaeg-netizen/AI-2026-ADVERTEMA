'use client'

import { useTransition } from 'react'
import { usePathname, useRouter } from 'next/navigation'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { Building2, Loader2, Tag } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Progress } from '@/components/ui/progress'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { SubscriptionStatusBadge } from '@/components/billing/status-badges'
import { usageLevel } from '@/components/billing/usage-bars'
import { useMoney } from '@/components/billing/use-money'
import { cn } from '@/lib/utils'
import { SUBSCRIPTION_STATUSES, type ClientSubscriptionRow, type SubscriptionStatus } from '@/lib/types/subscription'
import { LEVEL_CLASS } from './subscriptions-table'

const ALL = 'all'

/** Every client in every organization: business plan, price (set by its agency), usage. */
export function ClientSubscriptionsTable({
  rows,
  organizations,
  filters,
}: {
  rows: ClientSubscriptionRow[]
  organizations: { id: string; name: string }[]
  filters: { status?: SubscriptionStatus; organizationId?: string }
}) {
  const t = useTranslations('subscription.admin')
  const tClients = useTranslations('subscription.admin.clientsTab')
  const tStatus = useTranslations('subscription.status')
  const tUsage = useTranslations('subscription.usage.types')
  const locale = useLocale()
  const format = useFormatter()
  const money = useMoney()
  const router = useRouter()
  const pathname = usePathname()
  const [isPending, startTransition] = useTransition()

  function update(key: 'status' | 'org', value: string) {
    const next = { tab: 'clients', status: filters.status, org: filters.organizationId, [key]: value === ALL ? undefined : value }
    const params = new URLSearchParams()
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v)
    startTransition(() => router.replace(`${pathname}?${params.toString()}`, { scroll: false }))
  }

  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'medium' })

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
        <Select value={filters.organizationId ?? ALL} onValueChange={(v) => update('org', v)}>
          <SelectTrigger className="w-56" aria-label={tClients('filterOrganization')}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>{tClients('allOrganizations')}</SelectItem>
            {organizations.map((org) => (
              <SelectItem key={org.id} value={org.id}>
                {org.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {isPending && <Loader2 className="size-4 animate-spin text-muted-foreground" />}
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
          <Building2 className="size-8" />
          {tClients('empty')}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tClients('columns.client')}</TableHead>
                <TableHead>{tClients('columns.agency')}</TableHead>
                <TableHead>{t('columns.plan')}</TableHead>
                <TableHead className="text-end">{t('columns.price')}</TableHead>
                <TableHead>{t('columns.status')}</TableHead>
                <TableHead className="min-w-48">{t('columns.usage')}</TableHead>
                <TableHead>{t('columns.renewal')}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((row) => {
                const top = [...row.usage.filter((u) => u.limit !== null)].sort(
                  (a, b) => (b.percentage ?? 0) - (a.percentage ?? 0)
                )[0]
                const messages = row.usage.find((u) => u.limit_type === 'messages')
                return (
                  <TableRow key={row.subscription_id}>
                    <TableCell className="font-medium">{row.client_name}</TableCell>
                    <TableCell>
                      <Link href={`/admin/customers/${row.organization_id}`} className="hover:underline">
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
                          <Tag
                            className="size-3.5 text-emerald-600"
                            aria-label={row.custom_pricing_reason ?? t('customPrice')}
                          />
                        )}
                        {money.withCurrency(row.effective_price)}
                      </div>
                    </TableCell>
                    <TableCell>
                      <SubscriptionStatusBadge status={row.status} usable={row.usable} />
                    </TableCell>
                    <TableCell>
                      <div className="grid gap-1.5 text-xs">
                        {messages && (
                          <div className="flex justify-between gap-2 tabular-nums">
                            <span className="text-muted-foreground">{tUsage('messages')}</span>
                            <span>
                              {format.number(messages.used)}
                              {messages.limit !== null && ` / ${format.number(messages.limit)}`}
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
