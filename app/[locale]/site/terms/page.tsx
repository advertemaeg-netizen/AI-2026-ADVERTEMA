import { setRequestLocale } from 'next-intl/server'
import { LegalPage } from '@/site/components/legal-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  return siteMetadata(locale, '/terms', siteCopy(locale).legal.terms)
}

/** The terms of service: a DRAFT pending legal review (deploy/ROLLBACK.md, launch blocker) */
export default async function TermsPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const { legal } = siteCopy(locale)
  return <LegalPage locale={locale} page="/terms" notice={legal.draftNotice} copy={legal.terms} />
}
