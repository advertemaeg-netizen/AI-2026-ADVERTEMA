import { setRequestLocale } from 'next-intl/server'
import { LegalPage } from '@/site/components/legal-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  return siteMetadata(locale, '/privacy', siteCopy(locale).legal.privacy)
}

/** The privacy policy: a DRAFT pending legal review (deploy/ROLLBACK.md, launch blocker) */
export default async function PrivacyPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  return <LegalPage locale={locale} page="/privacy" copy={siteCopy(locale).legal.privacy} />
}
