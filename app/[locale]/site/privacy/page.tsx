import { setRequestLocale } from 'next-intl/server'
import { siteCopy } from '@/site/copy'
import { LegalRoute } from '@/site/legal-route'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string }> }

// LEGAL_REVALIDATE_SECONDS (src/site/legal-route.tsx): a segment config value must be a literal
export const revalidate = 300

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  return siteMetadata(locale, '/privacy', siteCopy(locale).legal.privacy)
}

/** The current version of the privacy policy, from public.legal_versions */
export default async function PrivacyPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  return <LegalRoute locale={locale} document="privacy" />
}
