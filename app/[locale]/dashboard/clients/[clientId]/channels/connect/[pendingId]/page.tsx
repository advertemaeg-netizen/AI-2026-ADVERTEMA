import { redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { getMetaConnectPicker } from '@/lib/actions/meta-connect'
import { requireClientManager } from '@/lib/auth/guards'
import { ConnectPicker } from './connect-picker'

/**
 * After the return from Meta: the accounts the token can see, and the clinic
 * picks which belongs to this client. Nothing is ticked to begin with; what
 * is ticked is what is connected. An expired or foreign pick goes back to the
 * channels page with `expired`.
 */
export default async function ConnectPickerPage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/channels/connect/[pendingId]'>) {
  const { locale, clientId, pendingId } = await params
  await requireClientManager(locale)
  const view = await getMetaConnectPicker(pendingId, clientId)
  if (!view) redirect(`/${locale}/dashboard/clients/${clientId}/channels?connect=expired`)

  const t = await getTranslations('channels.picker')
  return (
    <div className="page animate-enter">
      <div className="mb-6 max-w-2xl">
        <h1 className="page-title">{t('title', { client: view.clientName })}</h1>
        <p className="text-muted-foreground mt-1">{t('instruction')}</p>
      </div>
      <ConnectPicker view={view} />
    </div>
  )
}
