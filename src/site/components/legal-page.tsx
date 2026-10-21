import Link from 'next/link'
import { LegalMarkdown } from '@/components/legal-markdown'
import type { LegalVersion } from '@/lib/legal'
import type { SitePage as Page } from '@/site/config'
import { SitePage } from '@/site/components/site-page'

/**
 * A legal page: one version of the document (public.legal_versions), its
 * date, and every version before it at its own address. While the pages are
 * unlinked (SITE_LEGAL_LINKED off) it carries the draft notice.
 */
export function LegalPage({
  locale,
  page,
  notice,
  version,
  updated,
  history,
  older,
}: {
  locale: string
  page: Page
  /** The draft notice, while the pages are unlinked (SITE_LEGAL_LINKED); null after */
  notice: string | null
  version: LegalVersion
  /** "Last updated: <date>", from the copy file's own line with the version's date in it */
  updated: string
  history: { label: string; versions: { version: number; date: string; href: string }[] }
  /** On an earlier version: says so, and links to the current one */
  older?: { text: string; current: { label: string; href: string } }
}) {
  const earlier = history.versions.filter((v) => v.version !== version.version)
  return (
    <SitePage locale={locale} page={page}>
      <article className="site-panel-quiet mx-auto flex w-full max-w-3xl flex-col gap-8 p-6 md:p-10">
        <header className="flex flex-col gap-3">
          {notice && (
            <p role="note" className="rounded-lg border border-warning-solid bg-warning-solid/15 px-3 py-2 text-sm font-semibold">
              {notice}
            </p>
          )}
          {older && (
            <p role="note" className="rounded-lg border border-primary/30 bg-white/80 px-3 py-2 text-sm">
              {older.text}{' '}
              <Link href={older.current.href} className="font-semibold underline underline-offset-4">
                {older.current.label}
              </Link>
            </p>
          )}
          <h1 className="site-h2">{version.title}</h1>
          <p className="text-sm">{updated}</p>
        </header>
        <div className="flex flex-col gap-4">
          <LegalMarkdown text={version.body} />
        </div>
        {earlier.length > 0 && (
          <nav aria-label={history.label} className="flex flex-col gap-2 border-t border-border pt-6 text-sm">
            <h2 className="font-bold">{history.label}</h2>
            <ul className="flex flex-col gap-1">
              {earlier.map((v) => (
                <li key={v.version}>
                  <Link href={v.href} className="underline underline-offset-4">
                    {v.date}
                  </Link>
                </li>
              ))}
            </ul>
          </nav>
        )}
      </article>
    </SitePage>
  )
}
