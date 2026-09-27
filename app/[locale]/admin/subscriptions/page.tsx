import { getTranslations } from 'next-intl/server'
import { Link } from '@/i18n/navigation'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { cn } from '@/lib/utils'
import { getPlans } from '@/lib/actions/admin-plans'
import { getAllClientSubscriptions, getAllSubscriptions, getInvoiceOrganizations } from '@/lib/actions/admin-subscriptions'
import { UUID_PATTERN } from '@/lib/types/clients'
import { SUBSCRIPTION_STATUSES, type SubscriptionStatus } from '@/lib/types/subscription'
import { ClientSubscriptionsTable } from './_components/client-subscriptions-table'
import { SubscriptionsTable } from './_components/subscriptions-table'

const TABS = ['agencies', 'clients'] as const

/**
 * Agencies: each organization's agency plan, paid to the platform.
 * Clients: each client's business plan, paid to its agency.
 */
export default async function AdminSubscriptionsPage({ params, searchParams }: PageProps<'/[locale]/admin/subscriptions'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)

  const query = await searchParams
  const one = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : undefined)
  const tab = one('tab') === 'clients' ? 'clients' : 'agencies'
  const status = (SUBSCRIPTION_STATUSES as readonly string[]).includes(one('status') ?? '')
    ? (one('status') as SubscriptionStatus)
    : undefined
  const organizationId = UUID_PATTERN.test(one('org') ?? '') ? one('org') : undefined

  const t = await getTranslations('subscription.admin')

  return (
    <div className="p-8 grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <nav aria-label={t('tabs.label')} className="inline-flex w-fit rounded-lg bg-muted p-[3px]">
        {TABS.map((key) => (
          <Link
            key={key}
            href={key === 'agencies' ? '/admin/subscriptions' : '/admin/subscriptions?tab=clients'}
            aria-current={tab === key ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1.5 text-sm font-medium transition-colors',
              tab === key ? 'bg-background text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {t(`tabs.${key}`)}
          </Link>
        ))}
      </nav>

      {tab === 'agencies' ? <AgenciesTab status={status} /> : <ClientsTab status={status} organizationId={organizationId} />}
    </div>
  )
}

async function AgenciesTab({ status }: { status?: SubscriptionStatus }) {
  const t = await getTranslations('subscription.admin')
  const [rows, plans] = await Promise.all([getAllSubscriptions({ status }), getPlans()])
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('all')}</CardTitle>
        <CardDescription>{t('count', { count: rows.length })}</CardDescription>
      </CardHeader>
      <CardContent>
        <SubscriptionsTable rows={rows} plans={plans} filters={{ status }} />
      </CardContent>
    </Card>
  )
}

async function ClientsTab({ status, organizationId }: { status?: SubscriptionStatus; organizationId?: string }) {
  const t = await getTranslations('subscription.admin.clientsTab')
  const [rows, organizations] = await Promise.all([
    getAllClientSubscriptions({ status, organizationId }),
    getInvoiceOrganizations(),
  ])
  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('title')}</CardTitle>
        <CardDescription>{t('count', { count: rows.length })}</CardDescription>
      </CardHeader>
      <CardContent>
        <ClientSubscriptionsTable rows={rows} organizations={organizations} filters={{ status, organizationId }} />
      </CardContent>
    </Card>
  )
}
