import { routing } from '@/i18n/routing'
import { APP_ORIGIN, SITE_HOSTS, SITE_PAGES } from '@/site/config'

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
  | { kind: 'redirect'; to: string; status: 302 | 307 }
  /** No locale yet on a site host: next-intl adds it (a redirect to /ar/…) */
  | { kind: 'locale' }
  /** The internal segment asked for on the app's host */
  | { kind: 'notFound'; locale: string }

const LOCALES = routing.locales as readonly string[]
// Files Next generates inside the segment (og-image, icons): the head tags point at them
// An earlier version of a legal page, at its own address: /privacy/v/3
const LEGAL_VERSION = /^\/(?:privacy|terms)\/v\/[1-9]\d{0,5}$/
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
  if ((SITE_PAGES as readonly string[]).includes(after) || LEGAL_VERSION.test(after)) {
    return { kind: 'rewrite', to: `/${locale}/site${after}${search}` }
  }
  return { kind: 'redirect', to: `${APP_ORIGIN}${pathname}${search}`, status: 302 }
}
