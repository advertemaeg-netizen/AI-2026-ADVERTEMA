import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ArrowLeft } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getClient } from '@/lib/actions/clients'
import { ClientSubnav } from '../_components/client-subnav'
import { Playground } from './_components/playground'

export default async function PlaygroundPage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/playground'>) {
  const { clientId } = await params
  const client = await getClient(clientId)
  if (!client) notFound()

  const t = await getTranslations('playground')

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
        <p className="text-muted-foreground mt-1">{t('description')}</p>
      </div>

      <ClientSubnav clientId={clientId} />

      <Playground clientId={clientId} clientName={client.name} />
    </div>
  )
}
