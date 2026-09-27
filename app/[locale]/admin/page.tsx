import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getOrganizations, getPlatformStats } from '@/lib/actions/admin'
import { parseOrgListParams } from '@/lib/admin-list'
import { PlatformKpis } from './_components/platform-kpis'
import { OrganizationsTable } from './_components/organizations-table'

export default async function AdminOverviewPage({ params, searchParams }: PageProps<'/[locale]/admin'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)

  const t = await getTranslations('admin')
  const list = parseOrgListParams(await searchParams)
  const [stats, organizations] = await Promise.all([getPlatformStats(), getOrganizations(list.q, list.sort)])

  return (
    <div className="p-8 grid gap-8">
      <div>
        <h1 className="text-3xl font-bold tracking-tight">{t('overview.title')}</h1>
        <p className="text-muted-foreground mt-1">{t('overview.description')}</p>
      </div>

      {stats && <PlatformKpis stats={stats} />}

      <Card>
        <CardHeader>
          <CardTitle>{t('organizations.title')}</CardTitle>
          <CardDescription>{t('organizations.count', { count: organizations.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          <OrganizationsTable organizations={organizations} params={list} />
        </CardContent>
      </Card>
    </div>
  )
}
