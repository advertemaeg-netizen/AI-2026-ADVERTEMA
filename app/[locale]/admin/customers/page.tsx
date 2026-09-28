import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getOrganizations } from '@/lib/actions/admin'
import { parseOrgListParams } from '@/lib/admin-list'
import { CustomersTable } from '../_components/customers-table'

export default async function AdminCustomersPage({ params, searchParams }: PageProps<'/[locale]/admin/customers'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)

  const t = await getTranslations('admin.customers')
  const list = parseOrgListParams(await searchParams)
  const all = await getOrganizations(list.q, list.sort)
  const organizations = all.filter(
    (org) =>
      (!list.status || org.isActive === (list.status === 'active')) && (!list.type || org.orgType === list.type)
  )

  return (
    <div className="p-8">
      <div className="mb-8">
        <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('all')}</CardTitle>
          <CardDescription>{t('count', { count: organizations.length })}</CardDescription>
        </CardHeader>
        <CardContent>
          <CustomersTable organizations={organizations} params={list} showFilters />
        </CardContent>
      </Card>
    </div>
  )
}
