'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { Receipt } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import type { Invoice } from '@/lib/types/subscription'
import { InvoiceStatusBadge } from './status-badges'
import { InvoiceRowActions, type InvoiceScope } from './invoice-row-actions'
import { useMoney } from './use-money'

/**
 * Invoices list. `actions` adds row actions (platform: super admins,
 * agency: an agency on its client invoices). `showOrganization` /
 * `showClient` add who the invoice is for.
 */
export function InvoicesTable({ invoices, actions, showOrganization = false, showClient = false }: {
  invoices: Invoice[]
  actions?: InvoiceScope
  showOrganization?: boolean
  showClient?: boolean
}) {
  const t = useTranslations('invoices')
  const format = useFormatter()
  const money = useMoney()
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'medium' })

  if (invoices.length === 0) {
    return (
      <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
        <Receipt className="size-8" />
        {t('empty')}
      </div>
    )
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t('fields.number')}</TableHead>
          {showOrganization && <TableHead>{t('fields.organization')}</TableHead>}
          {showClient && <TableHead>{t('fields.client')}</TableHead>}
          <TableHead>{t('fields.period')}</TableHead>
          <TableHead className="text-end">{t('fields.amount')}</TableHead>
          <TableHead>{t('fields.status')}</TableHead>
          <TableHead>{t('fields.payment')}</TableHead>
          {actions && (
            <TableHead className="w-12">
              <span className="sr-only">{t('actions.label')}</span>
            </TableHead>
          )}
        </TableRow>
      </TableHeader>
      <TableBody>
        {invoices.map((invoice) => (
          <TableRow key={invoice.id}>
            <TableCell className="font-medium" dir="ltr">
              <span className="block text-start">{invoice.invoice_number}</span>
            </TableCell>
            {showOrganization && (
              <TableCell>
                <Link href={`/admin/organizations/${invoice.organization_id}`} className="hover:underline">
                  {invoice.organization_name}
                </Link>
                {invoice.billed_to === 'agency' && invoice.client_name && !showClient && (
                  <span className="block text-xs text-muted-foreground">{t('toClient', { client: invoice.client_name })}</span>
                )}
              </TableCell>
            )}
            {showClient && (
              <TableCell>
                {invoice.client_id ? (
                  <Link href={`/dashboard/clients/${invoice.client_id}/subscription`} className="hover:underline">
                    {invoice.client_name}
                  </Link>
                ) : (
                  '—'
                )}
              </TableCell>
            )}
            <TableCell className="text-muted-foreground">
              {t('periodRange', { from: date(invoice.period_start), to: date(invoice.period_end) })}
            </TableCell>
            <TableCell className="text-end font-medium tabular-nums">{money.withCurrency(invoice.amount)}</TableCell>
            <TableCell>
              <InvoiceStatusBadge status={invoice.status} />
            </TableCell>
            <TableCell className="text-sm text-muted-foreground">
              {invoice.status === 'paid' && invoice.paid_at ? (
                <div className="grid">
                  <span>
                    {date(invoice.paid_at)}
                    {invoice.payment_method && ` · ${t(`methods.${invoice.payment_method}`)}`}
                  </span>
                  {invoice.payment_reference && (
                    <span className="text-xs" dir="ltr">
                      <span className="block text-start">{invoice.payment_reference}</span>
                    </span>
                  )}
                </div>
              ) : (
                '—'
              )}
            </TableCell>
            {actions && (
              <TableCell>
                <InvoiceRowActions invoice={invoice} scope={actions} />
              </TableCell>
            )}
          </TableRow>
        ))}
      </TableBody>
    </Table>
  )
}
