import Link from 'next/link'
import { BrandLockup } from '@/components/brand'
import { APP_ORIGIN, type SitePage } from '@/site/config'
import { siteCopy } from '@/site/copy'
import { otherLocale, sitePath } from '@/site/paths'

const NAV: { page: SitePage; key: 'forBusinesses' | 'forAgencies' | 'pricing' | 'contact' }[] = [
  { page: '/for-businesses', key: 'forBusinesses' },
  { page: '/for-agencies', key: 'forAgencies' },
  { page: '/pricing', key: 'pricing' },
  { page: '/contact', key: 'contact' },
]

/**
 * The site's header: the lockup home, the pages, the other language (same
 * page), and the way into the product. Below md it is one row, the lockup and
 * a menu: at 390 the inline links clipped at the leading edge. The menu is a
 * <details>, so it works without script and from the keyboard.
 */
export function SiteHeader({ locale, page }: { locale: string; page: SitePage }) {
  const copy = siteCopy(locale)
  const other = otherLocale(locale)
  const links = NAV.map(({ page: target, key }) => ({ href: sitePath(locale, target), label: copy.nav[key], current: target === page }))
  const language = { href: sitePath(other, page), label: copy.nav.languageSwitch, lang: other }
  return (
    <header className="glass sticky top-0 z-40">
      <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
        <Link href={sitePath(locale, '')} aria-label={copy.nav.home} className="shrink-0">
          <BrandLockup height={28} />
        </Link>

        {/* md and up: inline */}
        <nav aria-label={copy.nav.menuLabel} className="site-nav-inline hidden min-w-0 flex-1 md:flex">
          <ul className="flex items-center gap-1">
            {links.map((link) => (
              <li key={link.href} className="flex-none">
                <Link href={link.href} aria-current={link.current ? 'page' : undefined} className="rounded-md px-2 py-1.5 text-sm aria-[current=page]:font-semibold">
                  {link.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
        <div className="ms-auto hidden flex-none items-center gap-3 text-sm md:flex">
          <Link href={language.href} hrefLang={language.lang} lang={language.lang} aria-label={copy.nav.languageSwitchLabel}>
            {language.label}
          </Link>
          <a href={`${APP_ORIGIN}/${locale}/login`}>{copy.nav.signIn}</a>
          <a href={`${APP_ORIGIN}/${locale}/signup`} className="rounded-md bg-primary px-3 py-1.5 text-primary-foreground">
            {copy.nav.signUp}
          </a>
        </div>

        {/* Below md: a menu */}
        <details className="site-menu group ms-auto md:hidden">
          <summary
            aria-label={copy.nav.menuLabel}
            className="grid size-11 cursor-pointer list-none place-items-center rounded-full border border-border bg-white/90 [&::-webkit-details-marker]:hidden"
          >
            <svg aria-hidden viewBox="0 0 24 24" className="size-5">
              <path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="group-open:hidden" />
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" className="hidden group-open:block" />
            </svg>
          </summary>
          {/* Opaque: over the hero's large type, any see-through fill lets the headline show through the links */}
          <div className="site-panel site-panel-solid absolute inset-x-4 top-[calc(100%+0.5rem)] flex flex-col gap-4 p-5">
            <nav aria-label={copy.nav.menuLabel} className="site-nav-menu">
              <ul className="flex flex-col">
                {links.map((link) => (
                  <li key={link.href}>
                    <Link href={link.href} aria-current={link.current ? 'page' : undefined} className="block rounded-md px-2 py-3 text-base aria-[current=page]:font-semibold">
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </nav>
            <div className="flex flex-wrap items-center gap-3 border-t border-border pt-4 text-base">
              <Link href={language.href} hrefLang={language.lang} lang={language.lang} aria-label={copy.nav.languageSwitchLabel}>
                {language.label}
              </Link>
              <a href={`${APP_ORIGIN}/${locale}/login`}>{copy.nav.signIn}</a>
              <a href={`${APP_ORIGIN}/${locale}/signup`} className="ms-auto rounded-full bg-primary px-4 py-2 text-primary-foreground">
                {copy.nav.signUp}
              </a>
            </div>
          </div>
        </details>
      </div>
    </header>
  )
}
