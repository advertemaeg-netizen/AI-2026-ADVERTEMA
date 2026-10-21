import { notFound } from 'next/navigation'
import { setRequestLocale } from 'next-intl/server'
import { LEGAL_PAGES } from '@/site/config'
import { siteCopy } from '@/site/copy'
import { LegalRoute, parseVersion } from '@/site/legal-route'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string; version: string }> }

// Rendered for each request and never cached: an earlier version is read
// almost never, and an uncached page writes nothing to the cache, so a request
// for a version that doesn't exist leaves no 404 behind whatever number is
// asked for. force-dynamic also makes this segment's fetches no-store. The
// current version (../../page.tsx) stays cached.
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  // The canonical is the current version's address
  return siteMetadata(locale, LEGAL_PAGES.privacy, siteCopy(locale).legal.privacy)
}

/** One version of the privacy policy, at its own address; it never changes */
export default async function PrivacyVersionPage({ params }: Props) {
  const { locale, version } = await params
  setRequestLocale(locale)
  const number = parseVersion(version)
  if (number === null) notFound()
  return <LegalRoute locale={locale} document="privacy" versionNumber={number} />
}
