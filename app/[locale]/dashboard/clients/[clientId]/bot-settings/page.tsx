import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ArrowLeft } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getClient, getClientPermissions } from '@/lib/actions/clients'
import { getBotSettings } from '@/lib/actions/bot-settings'
import { ClientSubnav } from '../_components/client-subnav'
import { BotSettingsForm } from './_components/bot-settings-form'

export default async function BotSettingsPage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/bot-settings'>) {
  const { clientId } = await params
  const [client, settings, { canManage }] = await Promise.all([
    getClient(clientId),
    getBotSettings(clientId),
    getClientPermissions(),
  ])
  if (!client || !settings) notFound()

  const t = await getTranslations('botSettings')

  return (
    <div className="p-8">
      <Link
        href="/dashboard/clients"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" />
        {t('backToClients')}
      </Link>

      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{t('title', { client: client.name })}</h1>
        <p className="text-muted-foreground mt-1">{canManage ? t('description') : t('readOnly')}</p>
      </div>

      <ClientSubnav clientId={clientId} />

      <BotSettingsForm
        clientId={clientId}
        clientName={client.name}
        initialSettings={settings}
        canManage={canManage}
      />
    </div>
  )
}
