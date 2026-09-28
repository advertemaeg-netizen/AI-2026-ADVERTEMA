import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getOrganizations, getPlatformStats } from '@/lib/actions/admin'
import { getImpersonationLog } from '@/lib/actions/impersonation'
import { parseOrgListParams } from '@/lib/admin-list'
import { PlatformKpis } from './_components/platform-kpis'
import { CustomersTable } from './_components/customers-table'
import { ImpersonationLog } from './_components/impersonation-log'

export default async function AdminOverviewPage({ params, searchParams }: PageProps<'/[locale]/admin'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)

  const t = await getTranslations('admin')
  const list = parseOrgListParams(await searchParams)
  const [stats, organizations, impersonations] = await Promise.all([
    getPlatformStats(),
    getOrganizations(list.q, list.sort),
    getImpersonationLog(),
  ])

  return (
    <div className="p-8 grid gap-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('overview.title')}</h1>
        <p className="text-muted-foreground mt-1">{t('overview.description')}</p>
      </div>

      {stats && <PlatformKpis stats={stats} />}

      <Card>
        <CardHeader>
          <CardTitle>{t('customers.title')}</CardTitle>
          <CardDescription>{t('customers.count', { count: organizations.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          <CustomersTable organizations={organizations} params={list} />
        </CardContent>
      </Card>

      <ImpersonationLog entries={impersonations} />
    </div>
  )
}
