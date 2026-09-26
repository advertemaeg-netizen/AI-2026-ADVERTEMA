import { getTranslations } from 'next-intl/server'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { getClientPermissions, getClients } from '@/lib/actions/clients'
import { ClientsTable } from './_components/clients-table'
import { ClientFormDialog } from './_components/client-form-dialog'

export default async function ClientsPage() {
  const t = await getTranslations('clients')
  const [clients, { canManage }] = await Promise.all([getClients(), getClientPermissions()])

  return (
    <div className="p-8">
      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">{t('title')}</h1>
          <p className="text-muted-foreground mt-1">{t('description')}</p>
        </div>
        {canManage && <ClientFormDialog mode="create" />}
      </div>

      <Card>
        <CardHeader>
          <CardTitle>{t('allClients')}</CardTitle>
          <CardDescription>
            {canManage ? t('count', { count: clients.length }) : t('readOnly')}
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ClientsTable clients={clients} canManage={canManage} />
        </CardContent>
      </Card>
    </div>
  )
}
