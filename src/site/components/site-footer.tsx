import Link from 'next/link'
import { BrandMark } from '@/components/brand'
import { siteCopy } from '@/site/copy'
import { sitePath } from '@/site/paths'

const PAGES = [
  ['', 'home'],
  ['/for-businesses', 'forBusinesses'],
  ['/for-agencies', 'forAgencies'],
  ['/pricing', 'pricing'],
  ['/contact', 'contact'],
] as const
// On every page: the privacy policy and the terms (drafts, gated by deploy/ROLLBACK.md)
const LEGAL = [
  ['/privacy', 'privacy'],
  ['/terms', 'terms'],
] as const

export function SiteFooter({ locale }: { locale: string }) {
  const copy = siteCopy(locale)
  return (
    <footer className="mt-32 border-t border-border [overflow-wrap:anywhere]">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-4 py-10 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-col gap-3">
          <BrandMark className="text-brand" />
          <p className="max-w-sm text-sm">{copy.footer.tagline}</p>
        </div>
        <nav aria-label={copy.nav.menuLabel}>
          <ul className="flex flex-wrap gap-x-5 gap-y-2 text-sm">
            {PAGES.map(([page, key]) => (
              <li key={page}>
                <Link href={sitePath(locale, page)}>{copy.nav[key]}</Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
      <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 pb-8 text-xs">
        <p>{copy.footer.rights}</p>
        <nav aria-label={copy.nav.legalLabel}>
          <ul className="flex gap-4">
            {LEGAL.map(([page, key]) => (
              <li key={page}>
                <Link href={sitePath(locale, page)} className="underline underline-offset-2">
                  {copy.nav[key]}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  )
}
