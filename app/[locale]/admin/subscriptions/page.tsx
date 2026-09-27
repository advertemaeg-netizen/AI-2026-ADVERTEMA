import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getPlans } from '@/lib/actions/admin-plans'
import { getAllSubscriptions } from '@/lib/actions/admin-subscriptions'
import { PLAN_TYPES, SUBSCRIPTION_STATUSES, type PlanType, type SubscriptionStatus } from '@/lib/types/subscription'
import { SubscriptionsTable } from './_components/subscriptions-table'

export default async function AdminSubscriptionsPage({ params, searchParams }: PageProps<'/[locale]/admin/subscriptions'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)

  const query = await searchParams
  const one = (key: string) => (typeof query[key] === 'string' ? (query[key] as string) : undefined)
  const filters = {
    planType: (PLAN_TYPES as readonly string[]).includes(one('type') ?? '') ? (one('type') as PlanType) : undefined,
    status: (SUBSCRIPTION_STATUSES as readonly string[]).includes(one('status') ?? '')
      ? (one('status') as SubscriptionStatus)
      : undefined,
  }

  const t = await getTranslations('subscription.admin')
  const [rows, plans] = await Promise.all([getAllSubscriptions(filters), getPlans()])

  return (
    <div className="p-8 grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>
      <Card>
        <CardHeader>
          <CardTitle>{t('all')}</CardTitle>
          <CardDescription>{t('count', { count: rows.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          <SubscriptionsTable rows={rows} plans={plans} filters={filters} />
        </CardContent>
      </Card>
    </div>
  )
}
