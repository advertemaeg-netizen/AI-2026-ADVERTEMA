import { getTranslations } from 'next-intl/server'
import { requireSuperAdmin } from '@/lib/auth/guards'
import { getLegalVersions } from '@/lib/actions/legal'
import { LegalEditor } from './_components/legal-editor'

/** The legal documents (public.legal_versions): publish a new version, read every earlier one */
export default async function AdminLegalPage({ params }: PageProps<'/[locale]/admin/legal'>) {
  const { locale } = await params
  await requireSuperAdmin(locale)
  const t = await getTranslations('admin.legal')
  const versions = await getLegalVersions()
  return (
    <div className="page animate-enter grid gap-6">
      <div>
        <h1 className="page-title">{t('title')}</h1>
        <p className="mt-1 max-w-3xl text-muted-foreground">{t('intro')}</p>
      </div>
      <LegalEditor versions={versions} />
    </div>
  )
}
