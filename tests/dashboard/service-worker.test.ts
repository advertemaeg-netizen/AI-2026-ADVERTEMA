import { readFileSync } from 'node:fs'
import path from 'node:path'
import { runInNewContext } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { routing } from '@/i18n/routing'
import { dashboardAppScope, manifestUrl, SERVICE_WORKER_URL } from '@/lib/install-prompt'
import { config } from '../../proxy'

/**
 * THE INSTALL PROMPT NEEDS A FETCH HANDLER (27 October 2026). Chrome fires
 * beforeinstallprompt only when a service worker with a fetch handler
 * controls the manifest's start_url, and it ignores an empty handler; without
 * the event the Android card never appears. So the real public/sw.js is run
 * here and must register a fetch handler that answers each request with the
 * network's own response, and nothing else (no cache: `caches` does not
 * exist in this sandbox, so touching it throws). And each locale's manifest
 * must start inside the scope the worker is registered with, and the proxy
 * must let the worker and the manifests through without a locale redirect.
 */

const PUBLIC = path.resolve(import.meta.dirname, '../../public')
const script = readFileSync(path.join(PUBLIC, SERVICE_WORKER_URL), 'utf8')

function runWorker(network: (request: unknown) => Promise<unknown>) {
  const listeners: [string, (event: unknown) => void][] = []
  runInNewContext(script, {
    self: { addEventListener: (type: string, listener: (event: unknown) => void) => listeners.push([type, listener]) },
    fetch: network,
  })
  return listeners
}

describe('public/sw.js', () => {
  it('registers a fetch handler and nothing else', () => {
    expect(runWorker(async () => new Response()).map(([type]) => type)).toEqual(['fetch'])
  })

  it('answers every request with the network’s own response: not empty, not cached', async () => {
    const request = { url: 'https://app.mudrik-ai.com/ar/dashboard', method: 'GET' }
    const fromNetwork = { status: 200 }
    const seen: unknown[] = []
    const [[, onFetch]] = runWorker(async (r) => (seen.push(r), fromNetwork))
    const answers: Promise<unknown>[] = []
    onFetch({ request, respondWith: (answer: Promise<unknown>) => answers.push(answer) })
    expect(answers).toHaveLength(1)
    await expect(answers[0]).resolves.toBe(fromNetwork)
    expect(seen).toEqual([request])
  })

  it('passes a network failure through as the failure it is', async () => {
    const [[, onFetch]] = runWorker(async () => {
      throw new TypeError('offline')
    })
    const answers: Promise<unknown>[] = []
    onFetch({ request: {}, respondWith: (answer: Promise<unknown>) => answers.push(answer) })
    await expect(answers[0]).rejects.toThrow('offline')
  })
})

describe('one installed app per locale', () => {
  it.each(routing.locales)('%s: the manifest starts at, and is scoped to, the dashboard the worker controls', (locale) => {
    const manifest = JSON.parse(readFileSync(path.join(PUBLIC, manifestUrl(locale)), 'utf8'))
    expect(manifest).toMatchObject({ start_url: dashboardAppScope(locale), scope: dashboardAppScope(locale), lang: locale })
    // Chrome's check: the start_url is inside the worker's scope
    expect(manifest.start_url.startsWith(dashboardAppScope(locale))).toBe(true)
  })

  it('the proxy lets the worker and every locale’s manifest through, and still sees the dashboard', () => {
    const matcher = new RegExp(`^${config.matcher[0]}$`)
    expect(matcher.test(SERVICE_WORKER_URL)).toBe(false)
    for (const locale of routing.locales) {
      expect(matcher.test(manifestUrl(locale))).toBe(false)
      expect(matcher.test(dashboardAppScope(locale))).toBe(true)
    }
  })
})
