import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { InvoicesTable } from '@/components/billing/invoices-table'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getAllInvoices, getInvoiceOrganizations } from '@/lib/actions/admin-subscriptions'
import { UUID_PATTERN } from '@/lib/types/clients'
import { BILLED_TO, INVOICE_STATUSES, type BilledTo, type InvoiceStatus } from '@/lib/types/subscription'
import { CreateInvoiceDialog } from '@/components/billing/create-invoice-dialog'
import { InvoiceFilters } from './_components/invoice-filters'

export default async function AdminInvoicesPage({ params, searchParams }: PageProps<'/[locale]/admin/invoices'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)

  const query = await searchParams
  const one = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : undefined)
  const filters = {
    status: (INVOICE_STATUSES as readonly string[]).includes(one('status') ?? '')
      ? (one('status') as InvoiceStatus)
      : undefined,
    organizationId: UUID_PATTERN.test(one('org') ?? '') ? one('org') : undefined,
    // platform: the platform's invoices to agencies; agency: agencies' invoices to their clients
    billedTo: (BILLED_TO as readonly string[]).includes(one('billed') ?? '') ? (one('billed') as BilledTo) : undefined,
  }

  const t = await getTranslations('invoices')
  const tTypes = await getTranslations('admin.customers.type')
  const [invoices, orgs] = await Promise.all([getAllInvoices(filters), getInvoiceOrganizations()])
  // Direct businesses are billed too (for their plan); say which is which
  const organizations = orgs.map((org) => ({
    id: org.id,
    name: org.org_type === 'direct' ? `${org.name} · ${tTypes('direct')}` : org.name,
  }))

  return (
    <div className="p-8 grid gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">{t('description')}</p>
        </div>
        <CreateInvoiceDialog parties={organizations} />
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('all')}</CardTitle>
          <CardDescription>{t('count', { count: invoices.length })}</CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4">
          <InvoiceFilters organizations={organizations} filters={filters} />
          <InvoicesTable invoices={invoices} actions="platform" showOrganization />
        </CardContent>
      </Card>
    </div>
  )
}
