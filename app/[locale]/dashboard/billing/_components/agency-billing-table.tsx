'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { Building2, FilePlus2, Tag } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { CreateInvoiceDialog } from '@/components/billing/create-invoice-dialog'
import { SubscriptionStatusBadge } from '@/components/billing/status-badges'
import { usageLevel } from '@/components/billing/usage-bars'
import { useMoney } from '@/components/billing/use-money'
import { cn } from '@/lib/utils'
import type { ClientBillingRow } from '@/lib/types/subscription'

const LEVEL_CLASS = {
  ok: '',
  warning: '[&_[data-slot=progress-indicator]]:bg-amber-500',
  critical: '[&_[data-slot=progress-indicator]]:bg-orange-600',
  full: '[&_[data-slot=progress-indicator]]:bg-destructive',
}

/** Every client of the agency: plan, effective price, usage, renewal, status, and "new invoice". */
export function AgencyBillingTable({ rows }: { rows: ClientBillingRow[] }) {
  const t = useTranslations('agencyBilling.clients')
  const tUsage = useTranslations('subscription.usage.types')
  const locale = useLocale()
  const format = useFormatter()
  const money = useMoney()
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'medium' })

  if (rows.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
        <Building2 className="size-8" />
        {t('empty')}
      </div>
    )
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t('columns.client')}</TableHead>
            <TableHead>{t('columns.plan')}</TableHead>
            <TableHead className="text-end">{t('columns.price')}</TableHead>
            <TableHead className="min-w-48">{t('columns.usage')}</TableHead>
            <TableHead>{t('columns.renewal')}</TableHead>
            <TableHead>{t('columns.status')}</TableHead>
            <TableHead className="w-12">
              <span className="sr-only">{t('columns.actions')}</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            // The most used limit tells the story; messages are shown too
            const top = [...row.usage.filter((u) => u.limit !== null)].sort(
              (a, b) => (b.percentage ?? 0) - (a.percentage ?? 0)
            )[0]
            const messages = row.usage.find((u) => u.limit_type === 'messages')
            return (
              <TableRow key={row.client_id}>
                <TableCell>
                  <Link href={`/dashboard/clients/${row.client_id}/subscription`} className="font-medium hover:underline">
                    {row.client_name}
                  </Link>
                  {row.open_invoices > 0 && (
                    <span className="block text-xs text-muted-foreground">
                      {t('openInvoices', { count: row.open_invoices, amount: money.withCurrency(row.open_amount) })}
                    </span>
                  )}
                </TableCell>
                <TableCell>{locale === 'ar' ? row.plan_name_ar : row.plan_name}</TableCell>
                <TableCell className="text-end tabular-nums">
                  {row.effective_price < row.base_price && (
                    <div className="text-xs text-muted-foreground line-through">{money.withCurrency(row.base_price)}</div>
                  )}
                  <div className="flex items-center justify-end gap-1 font-medium">
                    {row.has_custom_pricing && <Tag className="size-3.5 text-emerald-600" aria-label={t('customPrice')} />}
                    {money.withCurrency(row.effective_price)}
                  </div>
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
                <TableCell>
                  <SubscriptionStatusBadge status={row.status} usable={row.usable} />
                  {row.client_status !== 'active' && (
                    <Badge variant="outline" className="ms-1">
                      {t(`clientStatus.${row.client_status === 'archived' ? 'archived' : 'paused'}`)}
                    </Badge>
                  )}
                </TableCell>
                <TableCell>
                  <CreateInvoiceDialog
                    billedTo="agency"
                    parties={[]}
                    partyId={row.client_id}
                    trigger={
                      <Button variant="ghost" size="icon-sm" aria-label={t('createInvoice', { client: row.client_name })}>
                        <FilePlus2 />
                      </Button>
                    }
                  />
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
