import { notFound } from 'next/navigation'
import { setRequestLocale } from 'next-intl/server'
import { siteCopy } from '@/site/copy'
import { LegalRoute, parseVersion } from '@/site/legal-route'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string; version: string }> }

// Versions are published after the build: each is generated on its first visit, then cached
export const dynamicParams = true
export const revalidate = 300

export function generateStaticParams() {
  return []
}

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  // The canonical is the current version's address
  return siteMetadata(locale, '/privacy', siteCopy(locale).legal.privacy)
}

/** One version of the privacy policy, at its own address; it never changes */
export default async function PrivacyVersionPage({ params }: Props) {
  const { locale, version } = await params
  setRequestLocale(locale)
  const number = parseVersion(version)
  if (number === null) notFound()
  return <LegalRoute locale={locale} document="privacy" versionNumber={number} />
}
