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
    ['/ar/privacy-policy', '/ar/site/privacy-policy'],
    ['/en/privacy-policy', '/en/site/privacy-policy'],
    ['/ar/terms-of-service', '/ar/site/terms-of-service'],
    ['/en/terms-of-service/', '/en/site/terms-of-service'],
  ])('serves the marketing page %s from the internal segment', (path, to) => {
    expect(hostRoute(APEX, path)).toEqual({ kind: 'rewrite', to })
  })

  it('serves an earlier version of a legal page at its own address, and nothing else under it', () => {
    expect(hostRoute(APEX, '/ar/privacy-policy/v/5')).toEqual({ kind: 'rewrite', to: '/ar/site/privacy-policy/v/5' })
    expect(hostRoute(APEX, '/en/terms-of-service/v/2')).toEqual({ kind: 'rewrite', to: '/en/site/terms-of-service/v/2' })
    expect(hostRoute(APEX, '/ar/privacy-policy/v/999')).toEqual({ kind: 'rewrite', to: '/ar/site/privacy-policy/v/999' })
    // Not a version number: the same 404 as a number with no version behind it
    for (const path of [
      '/ar/privacy-policy/v/0',
      '/ar/privacy-policy/v/abc',
      '/ar/terms-of-service/v/3/x',
      '/ar/privacy-policy/v/1000',
      '/ar/terms-of-service/v/0012',
      '/en/privacy-policy/v',
      '/en/privacy-policy/v/',
    ]) {
      expect(hostRoute(APEX, path), path).toEqual({ kind: 'notFound', locale: path.split('/')[1] })
    }
    // Not a legal page: the app's, as before
    expect(hostRoute(APEX, '/ar/pricing/v/3').kind).toBe('redirect')
    expect(hostRoute(APEX, '/ar/privacy-policyx/v/3')).toMatchObject({ kind: 'redirect', status: 302 })
    expect(hostRoute(APEX, '/ar/privacyx/v/3')).toMatchObject({ kind: 'redirect', status: 302 })
  })

  // Served 200 on 2026-10-20 and 21, before the move: somebody's history has them
  it.each([
    ['/ar/privacy', '/ar/privacy-policy'],
    ['/en/privacy/', '/en/privacy-policy'],
    ['/en/terms', '/en/terms-of-service'],
    ['/ar/privacy/v/5', '/ar/privacy-policy/v/5'],
    ['/en/terms/v/2', '/en/terms-of-service/v/2'],
    // Lands on the new address's own 404, not the app's host
    ['/ar/terms/v/abc', '/ar/terms-of-service/v/abc'],
    ['/privacy', '/privacy-policy'],
    ['/terms/v/1', '/terms-of-service/v/1'],
  ])('moves the old address %s permanently to %s', (path, to) => {
    expect(hostRoute(APEX, path)).toEqual({ kind: 'redirect', to, status: 301 })
  })

  it('keeps the query string on the move', () => {
    expect(hostRoute(APEX, '/ar/terms', '?x=1')).toEqual({ kind: 'redirect', to: '/ar/terms-of-service?x=1', status: 301 })
  })

  it('takes the new address without a locale to next-intl first', () => {
    expect(hostRoute(APEX, '/privacy-policy')).toEqual({ kind: 'locale' })
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
  it.each(['/ar/dashboard', '/ar/login', '/api/webhook/website/abc', '/ar', '/en/pricing', '/ar/privacy'])('leaves %s to the product, as before', (path) => {
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
