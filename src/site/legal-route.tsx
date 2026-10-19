import { notFound } from 'next/navigation'
import { currentLegalVersion, legalHistory, legalVersion, type LegalDocument, type LegalLocale } from '@/lib/legal'
import { SITE_LEGAL_LINKED } from '@/site/config'
import { LegalPage } from '@/site/components/legal-page'
import { siteCopy } from '@/site/copy'
import { sitePath } from '@/site/paths'

/**
 * The two legal routes, current and earlier versions (app/[locale]/site/
 * {privacy,terms}). The text is public.legal_versions'; the words around it
 * are the copy file's.
 *
 * Cached and regenerated every LEGAL_REVALIDATE_SECONDS, and at once when a
 * super admin publishes (revalidatePath in src/lib/actions/legal.ts). Every
 * read throws on a database error, so a failed regeneration keeps serving the
 * last good page: a few minutes stale beats a 500.
 */
export const LEGAL_REVALIDATE_SECONDS = 300

const PATHS = { privacy: '/privacy', terms: '/terms' } as const

const formatDate = (iso: string, locale: LegalLocale) =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Cairo',
  }).format(new Date(iso))

/** The page for `document`: the current version, or `versionNumber` when given (404 when there is no such version) */
export async function LegalRoute({ locale, document, versionNumber }: { locale: string; document: LegalDocument; versionNumber?: number }) {
  const lang: LegalLocale = locale === 'en' ? 'en' : 'ar'
  const { legal } = siteCopy(locale)
  const current = await currentLegalVersion(document, lang)
  const shown = versionNumber === undefined ? current : await legalVersion(document, lang, versionNumber)
  if (!shown) notFound()
  const history = await legalHistory(document, lang)
  const base = sitePath(locale, PATHS[document])
  return (
    <LegalPage
      locale={locale}
      page={PATHS[document]}
      notice={SITE_LEGAL_LINKED ? null : legal.draftNotice}
      version={shown}
      // The copy file's own line, its [[date]] placeholder filled with this version's date
      updated={legal[document].updated.replace(/\[\[[^\]]+\]\]/, formatDate(shown.created_at, lang))}
      history={{
        label: legal.history,
        versions: history.map((v) => ({ version: v.version, date: `${formatDate(v.created_at, lang)} (${v.version})`, href: `${base}/v/${v.version}` })),
      }}
      older={shown.version === current.version ? undefined : { text: legal.olderVersion, current: { label: legal.currentLink, href: base } }}
    />
  )
}

/** The version number in an address ("3"), or null when it is not one */
export function parseVersion(value: string): number | null {
  return /^[1-9]\d{0,5}$/.test(value) ? Number(value) : null
}
