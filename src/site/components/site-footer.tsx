import Link from 'next/link'
import { BrandMark } from '@/components/brand'
import { SITE_LEGAL_LINKED, type SitePage } from '@/site/config'
import { siteCopy } from '@/site/copy'
import { sitePath } from '@/site/paths'

/**
 * The footer, on every page: the tagline, then the product and company
 * columns, and the legal one once the legal pages are linked
 * (SITE_LEGAL_LINKED: they are drafts until the review, deploy/ROLLBACK.md).
 * The year in footer.rights is written out in the copy, not computed: it is
 * reviewed each January.
 */
export function SiteFooter({ locale }: { locale: string }) {
  const copy = siteCopy(locale)
  const columns: { heading: string; links: { page: SitePage; label: string }[] }[] = [
    {
      heading: copy.footer.product,
      links: [
        { page: '/for-businesses', label: copy.nav.forBusinesses },
        { page: '/for-agencies', label: copy.nav.forAgencies },
        { page: '/pricing', label: copy.nav.pricing },
      ],
    },
    { heading: copy.footer.company, links: [{ page: '/contact', label: copy.nav.contact }] },
    ...(SITE_LEGAL_LINKED
      ? [
          {
            heading: copy.footer.legal,
            links: [
              { page: '/privacy' as const, label: copy.footer.privacy },
              { page: '/terms' as const, label: copy.footer.terms },
            ],
          },
        ]
      : []),
  ]
  return (
    <footer className="mt-32 border-t border-border [overflow-wrap:anywhere]">
      <div className={`mx-auto grid max-w-6xl gap-10 px-4 py-12 ${SITE_LEGAL_LINKED ? 'sm:grid-cols-[1.4fr_repeat(3,1fr)]' : 'sm:grid-cols-[1.4fr_repeat(2,1fr)]'}`}>
        <div className="flex flex-col gap-3">
          <BrandMark className="text-brand" />
          <p className="max-w-sm text-sm">{copy.footer.tagline}</p>
        </div>
        {columns.map((column) => (
          <nav key={column.heading} aria-label={column.heading} className="flex flex-col gap-3">
            <h2 className="text-sm font-bold">{column.heading}</h2>
            <ul className="flex flex-col gap-2 text-sm">
              {column.links.map((link) => (
                <li key={link.page}>
                  <Link href={sitePath(locale, link.page)}>{link.label}</Link>
                </li>
              ))}
            </ul>
          </nav>
        ))}
      </div>
      <p className="mx-auto max-w-6xl px-4 pb-8 text-xs">{copy.footer.rights}</p>
    </footer>
  )
}
