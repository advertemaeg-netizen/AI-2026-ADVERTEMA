import { getTranslations } from 'next-intl/server'
import { Card, CardContent } from '@/components/ui/card'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getPlans } from '@/lib/actions/admin-plans'
import { getAllClientSubscriptions, getAllSubscriptions } from '@/lib/actions/admin-subscriptions'
import { PlansManager } from './_components/plans-manager'

export default async function AdminPlansPage({ params }: PageProps<'/[locale]/admin/plans'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)

  const t = await getTranslations('plans')
  // Agency plans: organizations; business plans: clients
  const [plans, subscriptions, clientSubscriptions] = await Promise.all([
    getPlans(),
    getAllSubscriptions(),
    getAllClientSubscriptions(),
  ])
  const subscribers: Record<string, number> = {}
  for (const sub of [...subscriptions, ...clientSubscriptions]) {
    subscribers[sub.plan_id] = (subscribers[sub.plan_id] ?? 0) + 1
  }

  return (
    <div className="p-8 grid gap-6">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>
      <Card>
        <CardContent>
          <PlansManager plans={plans} subscribers={subscribers} />
        </CardContent>
      </Card>
    </div>
  )
}
