import { LegalMarkdown } from '@/components/legal-markdown'
import type { LegalVersion } from '@/lib/legal'
import type { SitePage as Page } from '@/site/config'
import { SitePage } from '@/site/components/site-page'

/**
 * A legal page: the current version of the document (public.legal_versions)
 * and its date. While the pages are unlinked (SITE_LEGAL_LINKED off) it
 * carries the draft notice.
 */
export function LegalPage({
  locale,
  page,
  notice,
  version,
  updated,
}: {
  locale: string
  page: Page
  /** The draft notice, while the pages are unlinked (SITE_LEGAL_LINKED); null after */
  notice: string | null
  version: LegalVersion
  /** "Last updated: <date>", from the copy file's own line with the version's date in it */
  updated: string
}) {
  return (
    <SitePage locale={locale} page={page}>
      <article className="site-panel-quiet mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-10">
        <header className="flex flex-col gap-3">
          {notice && (
            <p role="note" className="rounded-lg border border-warning-solid bg-warning-solid/15 px-3 py-2 text-sm font-semibold">
              {notice}
            </p>
          )}
          <h1 className="site-h2">{version.title}</h1>
          <p className="text-sm">{updated}</p>
        </header>
        <div className="flex flex-col gap-4">
          <LegalMarkdown text={version.body} />
        </div>
      </article>
    </SitePage>
  )
}
