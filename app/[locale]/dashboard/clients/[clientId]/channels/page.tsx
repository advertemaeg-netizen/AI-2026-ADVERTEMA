import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { Radio } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { getClient, getClientPermissions } from '@/lib/actions/clients'
import { getChannels } from '@/lib/actions/channels'
import { appOrigin } from '@/lib/app-url'
import { requireClientManager } from '@/lib/auth/guards'
import { BackToClients, ClientTabs } from '../_components/client-page-nav'
import { AddChannelDialog } from './_components/add-channel-dialog'
import { ChannelCard } from './_components/channel-card'

export default async function ChannelsPage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/channels'>) {
  const { locale, clientId } = await params
  // Also in the layout, but layouts don't re-run on client-side navigation
  await requireClientManager(locale)
  const client = await getClient(clientId)
  if (!client) notFound()

  const t = await getTranslations('channels')
  const [channels, { canManage }, origin] = await Promise.all([
    getChannels(clientId),
    getClientPermissions(),
    appOrigin(),
  ])

  return (
    <div className="p-8 max-md:p-4">
      <BackToClients label={t('backToClients')} />

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight max-md:text-2xl">
            {t('title', { client: client.name })}
          </h1>
          <p className="text-muted-foreground mt-1">
            {canManage ? t('description') : t('readOnly')}
          </p>
        </div>
        {canManage && <AddChannelDialog clientId={clientId} />}
      </div>

      <ClientTabs clientId={clientId} />

      {channels.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-12 text-center text-sm text-muted-foreground">
            <Radio className="size-8" />
            {canManage ? t('empty') : t('emptyReadOnly')}
          </CardContent>
        </Card>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {channels.map((channel) => (
            <ChannelCard key={channel.id} channel={channel} canManage={canManage} appOrigin={origin} />
          ))}
        </div>
      )}
    </div>
  )
}
