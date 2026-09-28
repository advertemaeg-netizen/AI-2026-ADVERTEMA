import { redirect } from 'next/navigation'
import { getFormatter, getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { CreateInvoiceDialog } from '@/components/billing/create-invoice-dialog'
import { InvoicesTable } from '@/components/billing/invoices-table'
import { getSession } from '@/lib/auth/session'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { redirectDirectBusiness } from '@/lib/auth/guards'
import { getAgencyClientInvoices, getAgencyClientsBilling, getMonthlyRevenue } from '@/lib/actions/agency-billing'
import { AgencyBillingTable } from './_components/agency-billing-table'

/**
 * The agency billing its clients: every client's plan, effective price,
 * usage and renewal, the expected monthly revenue, and the invoices the
 * agency issued. Prices come from the platform's plans (plus the agency's
 * custom prices for individual clients).
 */
export default async function AgencyBillingPage({ params }: PageProps<'/[locale]/dashboard/billing'>) {
  const { locale } = await params
  // Billing clients is an agency's business; a direct business has its subscription page
  await redirectDirectBusiness(locale, '/dashboard/subscription')
  const { profile } = await getSession()
  if (!profile) redirect(`/${locale}/login`)
  if (!isOrgAdmin(profile.role)) redirect(`/${locale}/dashboard`)

  const t = await getTranslations('agencyBilling')
  const format = await getFormatter()
  const currency = (await getTranslations('subscription'))('currency')
  const money = (value: number) => `${format.number(value, { maximumFractionDigits: 2 })} ${currency}`

  const [rows, invoices] = await Promise.all([getAgencyClientsBilling(), getAgencyClientInvoices()])
  const revenue = await getMonthlyRevenue(rows)
  const clients = rows.map((row) => ({ id: row.client_id, name: row.client_name }))

  const stats = revenue
    ? [
        {
          label: t('stats.expected'),
          value: money(revenue.expected),
          hint: t('stats.expectedHint', { count: revenue.payingClients }),
        },
        {
          label: t('stats.trialPipeline'),
          value: money(revenue.trialPipeline),
          hint: t('stats.trialPipelineHint', { count: revenue.trialingClients }),
        },
        { label: t('stats.outstanding'), value: money(revenue.outstanding), hint: t('stats.outstandingHint') },
        { label: t('stats.collected'), value: money(revenue.collectedThisMonth), hint: t('stats.collectedHint') },
      ]
    : []

  return (
    <div className="p-8 grid gap-6 max-md:p-4">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight max-md:text-2xl">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">{t('description')}</p>
        </div>
        {clients.length > 0 && <CreateInvoiceDialog billedTo="agency" parties={clients} />}
      </div>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {stats.map((stat) => (
          <Card key={stat.label}>
            <CardHeader className="pb-2">
              <CardDescription>{stat.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">{stat.value}</CardTitle>
            </CardHeader>
            <CardContent className="text-xs text-muted-foreground">{stat.hint}</CardContent>
          </Card>
        ))}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('clients.title')}</CardTitle>
          <CardDescription>{t('clients.count', { count: rows.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          <AgencyBillingTable rows={rows} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>{t('invoices.title')}</CardTitle>
          <CardDescription>{t('invoices.description')}</CardDescription>
        </CardHeader>
        <CardContent>
          <InvoicesTable invoices={invoices} actions="agency" showClient />
        </CardContent>
      </Card>
    </div>
  )
}
