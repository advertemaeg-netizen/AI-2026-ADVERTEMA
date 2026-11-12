import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { FileText } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Link } from '@/i18n/navigation'
import { getClient, getClientPermissions } from '@/lib/actions/clients'
import { getTemplates } from '@/lib/actions/templates'
import { requireClientManager } from '@/lib/auth/guards'
import { BackToClients, ClientTabs } from '../_components/client-page-nav'
import { TemplatesBoard } from './_components/templates-board'

/**
 * A client's WhatsApp message templates: read live from Meta on every visit
 * (src/lib/meta/templates.ts), created as UTILITY with no category field.
 */
export default async function TemplatesPage({ params }: PageProps<'/[locale]/dashboard/clients/[clientId]/templates'>) {
  const { locale, clientId } = await params
  // Also in the layout, but layouts don't re-run on client-side navigation
  await requireClientManager(locale)
  const client = await getClient(clientId)
  if (!client) notFound()

  const [t, tChannels] = await Promise.all([getTranslations('templates'), getTranslations('channels')])
  const [lists, { canManage }] = await Promise.all([getTemplates(clientId), getClientPermissions()])

  return (
    <div className="page animate-enter">
      <BackToClients label={tChannels('backToClients')} />

      <div className="mb-6">
        <h1 className="page-title">{t('title')}</h1>
        <p className="text-muted-foreground mt-1 max-w-3xl">{t('intro')}</p>
      </div>

      <ClientTabs clientId={clientId} />

      {lists.length === 0 ? (
        // No WhatsApp channel (or none with its credentials): templates live on one
        <Card>
          <CardContent className="flex flex-col items-center gap-4 py-12 text-center text-sm text-muted-foreground">
            <FileText className="size-8" aria-hidden />
            {canManage && (
              <Button asChild>
                <Link href={`/dashboard/clients/${clientId}/channels`}>{tChannels('addChannel.whatsapp.button')}</Link>
              </Button>
            )}
          </CardContent>
        </Card>
      ) : (
        <TemplatesBoard clientId={clientId} lists={lists} canManage={canManage} />
      )}
    </div>
  )
}
