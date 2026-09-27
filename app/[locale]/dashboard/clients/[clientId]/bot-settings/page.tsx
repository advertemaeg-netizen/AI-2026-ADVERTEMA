import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getClient, getClientPermissions } from '@/lib/actions/clients'
import { getBotSettings } from '@/lib/actions/bot-settings'
import { requireClientManager } from '@/lib/auth/guards'
import { BackToClients, ClientTabs } from '../_components/client-page-nav'
import { BotSettingsForm } from './_components/bot-settings-form'

export default async function BotSettingsPage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/bot-settings'>) {
  const { locale, clientId } = await params
  // Also in the layout, but layouts don't re-run on client-side navigation
  await requireClientManager(locale)
  const [client, settings, { canManage }] = await Promise.all([
    getClient(clientId),
    getBotSettings(clientId),
    getClientPermissions(),
  ])
  if (!client || !settings) notFound()

  const t = await getTranslations('botSettings')

  return (
    <div className="p-8">
      <BackToClients label={t('backToClients')} />

      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{t('title', { client: client.name })}</h1>
        <p className="text-muted-foreground mt-1">{canManage ? t('description') : t('readOnly')}</p>
      </div>

      <ClientTabs clientId={clientId} />

      <BotSettingsForm
        clientId={clientId}
        clientName={client.name}
        initialSettings={settings}
        canManage={canManage}
      />
    </div>
  )
}
