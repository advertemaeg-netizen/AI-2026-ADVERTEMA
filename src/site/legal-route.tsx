import { currentLegalVersion, type LegalDocument, type LegalLocale } from '@/lib/legal'
import { LEGAL_PAGES, SITE_LEGAL_LINKED } from '@/site/config'
import { LegalPage } from '@/site/components/legal-page'
import { siteCopy } from '@/site/copy'

/**
 * The two legal routes (app/[locale]/site/{privacy-policy,terms-of-service},
 * LEGAL_PAGES): the current version of the document, and only that. Earlier
 * versions have no public address (decided 2026-10-21): they are read in the
 * admin editor, and an acceptance's version id finds its text in the table.
 * The text is public.legal_versions'; the words around it are the copy file's.
 *
 * Cached and regenerated every LEGAL_REVALIDATE_SECONDS, and at once when a
 * super admin publishes (src/lib/actions/legal.ts). The read throws on a
 * database error, so a failed regeneration keeps serving the last good page:
 * a few minutes stale beats a 500.
 */
export const LEGAL_REVALIDATE_SECONDS = 300

const formatDate = (iso: string, locale: LegalLocale) =>
  new Intl.DateTimeFormat(locale === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Cairo',
  }).format(new Date(iso))

/** The page for `document`: its current version */
export async function LegalRoute({ locale, document }: { locale: string; document: LegalDocument }) {
  const lang: LegalLocale = locale === 'en' ? 'en' : 'ar'
  const { legal } = siteCopy(locale)
  const current = await currentLegalVersion(document, lang)
  return (
    <LegalPage
      locale={locale}
      page={LEGAL_PAGES[document]}
      notice={SITE_LEGAL_LINKED ? null : legal.draftNotice}
      version={current}
      // The copy file's own line, its [[date]] placeholder filled with this version's date
      updated={legal[document].updated.replace(/\[\[[^\]]+\]\]/, formatDate(current.created_at, lang))}
    />
  )
}
