import { describe, expect, it } from 'vitest'
import { hostRoute } from '@/site/host-routing'

/**
 * One host per concern: the site's hosts serve the marketing pages and
 * nothing else, and the app's host never shows them.
 */

const APEX = 'mudrik-ai.com'
const APP = 'app.mudrik-ai.com'

describe('on the site’s hosts', () => {
  it.each([
    ['/ar', '/ar/site'],
    ['/ar/', '/ar/site'],
    ['/en', '/en/site'],
    ['/ar/pricing', '/ar/site/pricing'],
    ['/en/for-businesses', '/en/site/for-businesses'],
    ['/ar/for-agencies', '/ar/site/for-agencies'],
    ['/en/contact/', '/en/site/contact'],
    ['/ar/privacy', '/ar/site/privacy'],
    ['/en/terms', '/en/site/terms'],
  ])('serves the marketing page %s from the internal segment', (path, to) => {
    expect(hostRoute(APEX, path)).toEqual({ kind: 'rewrite', to })
  })

  it('serves an earlier version of a legal page at its own address, and nothing else under it', () => {
    expect(hostRoute(APEX, '/ar/privacy/v/3')).toEqual({ kind: 'rewrite', to: '/ar/site/privacy/v/3' })
    expect(hostRoute(APEX, '/en/terms/v/12')).toEqual({ kind: 'rewrite', to: '/en/site/terms/v/12' })
    expect(hostRoute(APEX, '/ar/privacy/v/999')).toEqual({ kind: 'rewrite', to: '/ar/site/privacy/v/999' })
    // Not a version number: the same 404 as a number with no version behind it
    for (const path of ['/ar/privacy/v/0', '/ar/privacy/v/abc', '/ar/terms/v/3/x', '/ar/privacy/v/1000', '/ar/terms/v/0012', '/en/privacy/v', '/en/privacy/v/']) {
      expect(hostRoute(APEX, path), path).toEqual({ kind: 'notFound', locale: path.split('/')[1] })
    }
    // Not a legal page: the app's, as before
    expect(hostRoute(APEX, '/ar/pricing/v/3').kind).toBe('redirect')
    expect(hostRoute(APEX, '/ar/privacyx/v/3').kind).toBe('redirect')
  })

  it('keeps the query string', () => {
    expect(hostRoute(APEX, '/ar/pricing', '?utm_source=x')).toEqual({ kind: 'rewrite', to: '/ar/site/pricing?utm_source=x' })
  })

  it('lets next-intl add the locale to a marketing path that has none', () => {
    expect(hostRoute(APEX, '/')).toEqual({ kind: 'locale' })
    expect(hostRoute(APEX, '/pricing')).toEqual({ kind: 'locale' })
  })

  // Auth cookies are per host: signing in on the apex would leave the visitor signed out on app.
  it.each(['/ar/login', '/en/dashboard', '/ar/signup', '/ar/dashboard/leads', '/auth/callback', '/login'])(
    'sends %s to the same path on the app’s host (302)',
    (path) => {
      expect(hostRoute(APEX, path, '?next=1')).toEqual({ kind: 'redirect', to: `https://app.mudrik-ai.com${path}?next=1`, status: 302 })
    }
  )

  it('sends /api to the app’s host with a 307, so a POST stays a POST', () => {
    expect(hostRoute(APEX, '/api/webhook/website/abc')).toEqual({
      kind: 'redirect',
      to: 'https://app.mudrik-ai.com/api/webhook/website/abc',
      status: 307,
    })
  })

  it('never gives one page two URLs: /ar/site/pricing goes to /ar/pricing', () => {
    expect(hostRoute(APEX, '/ar/site/pricing')).toEqual({ kind: 'redirect', to: '/ar/pricing', status: 302 })
    expect(hostRoute(APEX, '/ar/site')).toEqual({ kind: 'redirect', to: '/ar', status: 302 })
  })

  it('serves the og-image Next writes into the head, which lives at the segment’s own URL', () => {
    expect(hostRoute(APEX, '/ar/site/opengraph-image/og', '?abc')).toEqual({ kind: 'rewrite', to: '/ar/site/opengraph-image/og?abc' })
  })

  it('treats www and a port the same way, and ignores case', () => {
    expect(hostRoute('www.mudrik-ai.com', '/ar')).toEqual({ kind: 'rewrite', to: '/ar/site' })
    expect(hostRoute('Mudrik-AI.com:443', '/ar')).toEqual({ kind: 'rewrite', to: '/ar/site' })
    expect(hostRoute('site.localhost:3000', '/en/pricing')).toEqual({ kind: 'rewrite', to: '/en/site/pricing' })
  })
})

describe('on the app’s host', () => {
  it.each(['/ar/dashboard', '/ar/login', '/api/webhook/website/abc', '/ar', '/en/pricing'])('leaves %s to the product, as before', (path) => {
    expect(hostRoute(APP, path)).toEqual({ kind: 'app' })
  })

  it.each(['/ar/site', '/ar/site/pricing', '/en/site/', '/en/site/opengraph-image/og'])('answers the internal segment %s with a 404', (path) => {
    expect(hostRoute(APP, path)).toEqual({ kind: 'notFound', locale: path.slice(1, 3) })
  })

  it('treats any host it does not know (the old host, localhost) as the app’s', () => {
    expect(hostRoute('app.srv1995277.hstgr.cloud', '/ar/dashboard')).toEqual({ kind: 'app' })
    expect(hostRoute('localhost:3000', '/ar/site/pricing')).toEqual({ kind: 'notFound', locale: 'ar' })
    expect(hostRoute(null, '/ar')).toEqual({ kind: 'app' })
  })
})
