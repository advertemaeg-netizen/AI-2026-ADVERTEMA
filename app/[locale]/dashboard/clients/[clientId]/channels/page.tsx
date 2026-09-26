import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ArrowLeft, BookOpen, Radio } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { getClient, getClientPermissions } from '@/lib/actions/clients'
import { getChannels } from '@/lib/actions/channels'
import { AddChannelDialog } from './_components/add-channel-dialog'
import { ChannelCard } from './_components/channel-card'

export default async function ChannelsPage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/channels'>) {
  const { clientId } = await params
  const client = await getClient(clientId)
  if (!client) notFound()

  const t = await getTranslations('channels')
  const [channels, { canManage }] = await Promise.all([
    getChannels(clientId),
    getClientPermissions(),
  ])

  return (
    <div className="p-8">
      <Link
        href="/dashboard/clients"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" />
        {t('backToClients')}
      </Link>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">
            {t('title', { client: client.name })}
          </h1>
          <p className="text-muted-foreground mt-1">
            {canManage ? t('description') : t('readOnly')}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" asChild>
            <Link href={`/dashboard/clients/${clientId}/knowledge`}>
              <BookOpen data-icon="inline-start" />
              {t('knowledgeLink')}
            </Link>
          </Button>
          {canManage && <AddChannelDialog clientId={clientId} />}
        </div>
      </div>

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
            <ChannelCard key={channel.id} channel={channel} canManage={canManage} />
          ))}
        </div>
      )}
    </div>
  )
}
