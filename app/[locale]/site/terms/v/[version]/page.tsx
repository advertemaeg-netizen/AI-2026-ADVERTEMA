import { notFound } from 'next/navigation'
import { setRequestLocale } from 'next-intl/server'
import { siteCopy } from '@/site/copy'
import { LegalRoute, parseVersion } from '@/site/legal-route'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string; version: string }> }

// Rendered for each request and never cached: see ../../../privacy/v/[version]/page.tsx
export const dynamic = 'force-dynamic'

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  // The canonical is the current version's address
  return siteMetadata(locale, '/terms', siteCopy(locale).legal.terms)
}

/** One version of the terms, at its own address; it never changes */
export default async function TermsVersionPage({ params }: Props) {
  const { locale, version } = await params
  setRequestLocale(locale)
  const number = parseVersion(version)
  if (number === null) notFound()
  return <LegalRoute locale={locale} document="terms" versionNumber={number} />
}
