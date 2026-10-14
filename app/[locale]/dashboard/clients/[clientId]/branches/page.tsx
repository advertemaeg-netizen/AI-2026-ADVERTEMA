import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Info, MapPin } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { getClient } from '@/lib/actions/clients'
import { getBranches } from '@/lib/actions/branches'
import { requireClientManager } from '@/lib/auth/guards'
import { BackToClients, ClientTabs } from '../_components/client-page-nav'
import { AddBranchButton } from './_components/add-branch-button'
import { BranchCard } from './_components/branch-card'

export default async function BranchesPage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/branches'>) {
  const { locale, clientId } = await params
  // Also in the layout, but layouts don't re-run on client-side navigation
  await requireClientManager(locale)
  const client = await getClient(clientId)
  if (!client) notFound()

  const t = await getTranslations('branches')
  const tChannels = await getTranslations('channels')
  const branches = await getBranches(clientId)
  const names = branches.map(({ id, name }) => ({ id, name }))

  return (
    <div className="page animate-enter">
      <BackToClients label={tChannels('backToClients')} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="page-title">{t('title', { client: client.name })}</h1>
          <p className="text-muted-foreground mt-1">{t('description')}</p>
        </div>
        <AddBranchButton clientId={clientId} />
      </div>

      <ClientTabs clientId={clientId} />

      {/* TODO(booking gate): remove once booking reads hours and closures from branches */}
      <p className="mb-4 flex items-start gap-2 rounded-lg border bg-muted/50 p-3 text-sm text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        {t('notInUse')}
      </p>

      {branches.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <MapPin className="size-8" />
            {t('empty')}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {branches.map((branch) => (
            <BranchCard key={branch.id} clientId={clientId} branch={branch} branches={names} />
          ))}
        </div>
      )}
    </div>
  )
}
