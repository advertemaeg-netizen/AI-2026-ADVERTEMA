import { notFound } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { ArrowLeft } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { getClient, getClientPermissions } from '@/lib/actions/clients'
import { getKnowledgeDocuments } from '@/lib/actions/knowledge'
import { requireClientManager } from '@/lib/auth/guards'
import { ClientSubnav } from '../_components/client-subnav'
import { UploadCard } from './_components/upload-card'
import { DocumentsList } from './_components/documents-list'

export default async function KnowledgePage({
  params,
}: PageProps<'/[locale]/dashboard/clients/[clientId]/knowledge'>) {
  const { locale, clientId } = await params
  // Also in the layout, but layouts don't re-run on client-side navigation
  await requireClientManager(locale)
  const client = await getClient(clientId)
  if (!client) notFound()

  const t = await getTranslations('knowledge')
  const [documents, { canManage }] = await Promise.all([
    getKnowledgeDocuments(clientId),
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

      <div className="mb-6">
        <h1 className="text-3xl font-bold tracking-tight">{t('title', { client: client.name })}</h1>
        <p className="text-muted-foreground mt-1">{canManage ? t('description') : t('readOnly')}</p>
      </div>

      <ClientSubnav clientId={clientId} />

      <div className="grid gap-6">
        {canManage && <UploadCard clientId={clientId} />}
        <DocumentsList documents={documents} canManage={canManage} />
      </div>
    </div>
  )
}
