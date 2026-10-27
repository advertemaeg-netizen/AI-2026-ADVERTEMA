import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'
// .mjs names vitest.config.mts, as TypeScript and Vite both resolve it
import config from '../../vitest.config.mjs'
import { instrumented, isInstrumented, WATCHDOG_MS } from '../harness/access-fetch'

/**
 * NO ACCESS FILE CAN MISS THE INSTRUMENT (27 October 2026).
 *
 * The queue, the retry and the watchdog that names a hung statement used to
 * be copied into each access file. channel-secrets.test.ts copied the first
 * two and not the watchdog, everything read green, and the first real hang
 * there named nothing. They now live once, on the access project's global
 * fetch (tests/harness/access-fetch.ts). This test fails the day any of it
 * can be bypassed: the global fetch not instrumented, a file in tests/access
 * bringing its own fetch, or a timeout short enough to fire before the
 * watchdog does.
 */

const DIR = import.meta.dirname
const files = readdirSync(DIR).filter((f) => f.endsWith('.ts') && f !== 'instrument.test.ts')
const source = (f: string) => readFileSync(path.join(DIR, f), 'utf8')

type Project = { test?: { name?: string; setupFiles?: string[]; testTimeout?: number; hookTimeout?: number } }
const access = ((config as { test?: { projects?: Project[] } }).test?.projects ?? []).find((p) => p.test?.name === 'access')

describe('the access instrument', () => {
  it('is the global fetch every access file reaches', () => {
    expect(isInstrumented(globalThis.fetch)).toBe(true)
    expect(access?.test?.setupFiles).toContain('tests/harness/access-setup.ts')
  })

  it('cannot be bypassed: no access file brings its own fetch or replaces the global', () => {
    const bypasses = files.filter((f) => /\bfetch\s*:|stubGlobal\(\s*['"]fetch|unstubAllGlobals|globalThis\.fetch\s*=/.test(source(f)))
    expect(bypasses).toEqual([])
  })

  it('names the request it is waiting on once WATCHDOG_MS passes without an answer', async () => {
    vi.useFakeTimers()
    const printed: string[] = []
    const spy = vi.spyOn(console, 'error').mockImplementation((line: string) => void printed.push(line))
    try {
      const hung = instrumented(() => new Promise<Response>(() => {}))
      void hung('http://127.0.0.1/channel_secrets?select=*', { method: 'GET' })
      await vi.advanceTimersByTimeAsync(WATCHDOG_MS - 1)
      expect(printed).toEqual([])
      await vi.advanceTimersByTimeAsync(1)
      expect(printed).toEqual([`[access] no answer for ${WATCHDOG_MS / 1000} s; waiting on: GET /channel_secrets?select=* `])
    } finally {
      spy.mockRestore()
      vi.useRealTimers()
    }
  })

  it('fires before any timeout of the access project', () => {
    expect(access?.test?.testTimeout).toBeGreaterThan(WATCHDOG_MS)
    expect(access?.test?.hookTimeout).toBeGreaterThan(WATCHDOG_MS)
    // A timeout given to one test or hook: the number closing its call ("}, 120_000)") or a timeout option
    const short = files.flatMap((f) =>
      [...source(f).matchAll(/\},\s*([\d_]+)\s*\)|[tT]imeout\s*:\s*([\d_]+)/g)]
        .map((m) => [f, Number((m[1] ?? m[2]).replace(/_/g, ''))] as const)
        .filter(([, ms]) => ms <= WATCHDOG_MS)
    )
    expect(short).toEqual([])
    expect(files.filter((f) => /setConfig\(/.test(source(f)))).toEqual([])
  })
})
