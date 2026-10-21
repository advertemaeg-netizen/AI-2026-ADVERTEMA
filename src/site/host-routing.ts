import { routing } from '@/i18n/routing'
import { APP_ORIGIN, LEGAL_PAGES, SITE_HOSTS, SITE_PAGES } from '@/site/config'

/**
 * What a request is, by its host, before the product's own proxy runs.
 *
 * One host per concern: the site's hosts serve the marketing pages and
 * nothing else; every other path there goes to the same path on the app's
 * host (302 while things are still moving, 307 for /api so a POST stays a
 * POST). Auth cookies are per host, so the product must never be served from
 * the apex. And the app's host never shows the site: its internal /site
 * segment answers 404 there.
 */
export type HostRoute =
  /** Not the site's concern: the product's proxy handles it as before */
  | { kind: 'app' }
  /** A marketing page: serve it from the internal segment */
  | { kind: 'rewrite'; to: string }
  | { kind: 'redirect'; to: string; status: 301 | 302 | 307 }
  /** No locale yet on a site host: next-intl adds it (a redirect to /ar/…) */
  | { kind: 'locale' }
  /** The internal segment asked for on the app's host, or a legal page's version address (there are none) */
  | { kind: 'notFound'; locale: string }

const LOCALES = routing.locales as readonly string[]
const LEGAL = `(?:${Object.values(LEGAL_PAGES).map((page) => page.slice(1)).join('|')})`
// Earlier versions have no public address (decided 2026-10-21): anything under
// a legal page's /v is a 404, whatever follows, never a render and never a
// trip to the app's host
const LEGAL_VERSION = new RegExp(`^/${LEGAL}/v(?:/|$)`)
// The legal pages' first addresses, and their versions': answered 200 on
// 2026-10-20 and 21 before the move, so they are kept, permanently, as
// redirects to the current page (a version address included)
const LEGAL_FORMER = /^\/(privacy|terms)(?:\/v(?:\/.*)?)?\/?$/
// Files Next generates inside the segment (og-image, icons): the head tags point at them
const SEGMENT_FILE = /^\/(?:opengraph-image|twitter-image|icon|apple-icon)(?:[-.?/]|$)/

export function hostRoute(host: string | null, pathname: string, search = ''): HostRoute {
  const hostname = (host ?? '').toLowerCase().replace(/:\d+$/, '')
  const [, first = '', ...rest] = pathname.split('/')
  const locale = LOCALES.includes(first) ? first : null
  const after = locale ? `/${rest.join('/')}`.replace(/\/$/, '') : pathname
  const inSegment = locale !== null && (after === '/site' || after.startsWith('/site/'))

  if (!SITE_HOSTS.includes(hostname)) {
    return inSegment ? { kind: 'notFound', locale: locale! } : { kind: 'app' }
  }

  if (pathname.startsWith('/api/')) return { kind: 'redirect', to: `${APP_ORIGIN}${pathname}${search}`, status: 307 }
  const former = after.match(LEGAL_FORMER)
  if (former) {
    const page = LEGAL_PAGES[former[1] as keyof typeof LEGAL_PAGES]
    return { kind: 'redirect', to: `${locale ? `/${locale}` : ''}${page}${search}`, status: 301 }
  }
  if (!locale) {
    // "/" and "/pricing" get their locale first; anything else is the app's
    return (SITE_PAGES as readonly string[]).includes(pathname.replace(/\/$/, ''))
      ? { kind: 'locale' }
      : { kind: 'redirect', to: `${APP_ORIGIN}${pathname}${search}`, status: 302 }
  }
  if (inSegment) {
    const inner = after.slice('/site'.length)
    // The segment's generated files are fetched by the URL Next writes into the head
    if (SEGMENT_FILE.test(inner)) return { kind: 'rewrite', to: `${pathname}${search}` }
    // Never two URLs for one page: /ar/site/pricing is /ar/pricing
    return { kind: 'redirect', to: `/${locale}${inner}${search}`, status: 302 }
  }
  if ((SITE_PAGES as readonly string[]).includes(after)) return { kind: 'rewrite', to: `/${locale}/site${after}${search}` }
  if (LEGAL_VERSION.test(after)) return { kind: 'notFound', locale }
  return { kind: 'redirect', to: `${APP_ORIGIN}${pathname}${search}`, status: 302 }
}
