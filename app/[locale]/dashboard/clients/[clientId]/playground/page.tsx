import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getClient } from '@/lib/actions/clients'
import { getBotSettings } from '@/lib/actions/bot-settings'
import { requireClientManager } from '@/lib/auth/guards'
import { BackToClients, ClientTabs } from '../_components/client-page-nav'
import { Playground } from './_components/playground'

export default async function PlaygroundPage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/playground'>) {
  const { locale, clientId } = await params
  // Also in the layout, but layouts don't re-run on client-side navigation
  await requireClientManager(locale)
  const [client, settings] = await Promise.all([getClient(clientId), getBotSettings(clientId)])
  if (!client || !settings) notFound()

  const t = await getTranslations('playground')

  return (
    <div className="p-8">
      <BackToClients label={t('backToClients')} />

      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{t('title', { client: client.name })}</h1>
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <ClientTabs clientId={clientId} />

      <Playground clientId={clientId} clientName={client.name} welcomeMessage={settings.welcome_message} />
    </div>
  )
}
