import { readFileSync, readdirSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { classify } from '../../scripts/access-stuck-signature.mjs'

/**
 * THE STUCK STATE IS DECIDED BY A SCRIPT, NEVER BY EYE (AGENTS.md, the
 * interim rerun rule; tests/harness/access-fetch.ts, "THE STUCK STATE").
 *
 * A stuck run is the one failure that may be rerun, so the script that names
 * one must say no to everything else. These hold it against the twelve real
 * failed logs we have, every one of which it must call NOT STUCK, each for
 * its own reason:
 *   - seven runs that failed one real assertion (a 60 s limit under the
 *     watchdog's 90, a mistake made and dropped on 2026-11-09);
 *   - three runs that went stuck AND failed that assertion: not pure stuck
 *     runs, so not stuck. Two were cut off before vitest's summary, which is
 *     itself disqualifying: a log that never explains its failures cannot show
 *     none of them is real;
 *   - two full-check failures from before the stuck state had its positive
 *     mark (`[access] slow reconnect`): without it a stuck run and a test grown
 *     too slow for its limit look alike, so neither is called stuck.
 * The positive case is the most stuck-shaped of them with the marks it would
 * now carry; every rule is then broken once on it, and each must turn it.
 */

const FIXTURES = path.join(__dirname, 'fixtures', 'access-runs')
const read = (name: string) => readFileSync(path.join(FIXTURES, name), 'utf8')
const verdict = (log: string): { stuck: boolean; why: string } => classify(log)

const REAL: Record<string, RegExp> = {
  '2026-11-08-full-check-061cc63.log': /slow-reconnect mark/,
  '2026-11-08-full-check-21d48e4.log': /slow-reconnect mark/,
  '2026-11-09-access-alone-run-01.log': /not a timeout or a connection code: AssertionError/,
  '2026-11-09-access-alone-run-02.log': /not a timeout or a connection code: AssertionError/,
  '2026-11-09-access-alone-run-03.log': /ends before vitest’s summary/,
  '2026-11-09-access-alone-run-04.log': /not a timeout or a connection code: AssertionError/,
  '2026-11-09-access-alone-run-05.log': /not a timeout or a connection code: AssertionError/,
  '2026-11-09-access-alone-run-06.log': /not a timeout or a connection code: AssertionError/,
  '2026-11-09-access-alone-run-07.log': /not a timeout or a connection code: Error: Snapshot/,
  '2026-11-09-access-alone-run-08.log': /not a timeout or a connection code: AssertionError/,
  '2026-11-09-access-alone-run-09.log': /not a timeout or a connection code: AssertionError/,
  '2026-11-09-access-alone-run-10.log': /ends before vitest’s summary/,
}

describe('the twelve real failed logs', () => {
  it('are all of them here, and nothing else', () => {
    expect(readdirSync(FIXTURES).sort()).toEqual(Object.keys(REAL).sort())
  })

  for (const [name, why] of Object.entries(REAL)) {
    it(`${name}: not stuck, for its own reason`, () => {
      const result = verdict(read(name))
      expect(result.stuck).toBe(false)
      expect(result.why).toMatch(why)
    })
  }
})

describe('a stuck run, and every rule broken once on it', () => {
  // The most stuck-shaped real log: one test past its limit, connection errors after, a whole log
  const base = read('2026-11-08-full-check-061cc63.log')
  const marks = (n: number) =>
    Array.from({ length: n }, (_, i) => `[access] slow reconnect: ${9 + (i % 4)} s before an answer to GET /rest/v1/channel_secrets?select=*`).join('\n')
  const stuck = `${marks(12)}\n${base}`

  it('with its marks, it is stuck', () => {
    expect(verdict(stuck)).toMatchObject({ stuck: true })
  })

  it('two marks are not enough', () => {
    expect(verdict(`${marks(2)}\n${base}`)).toMatchObject({ stuck: false, why: expect.stringMatching(/2 slow-reconnect mark/) })
  })

  it('one real assertion failure anywhere, and it is not', () => {
    expect(verdict(`${stuck}\nAssertionError: expected 'allowed' to be 'refused'`)).toMatchObject({ stuck: false, why: expect.stringMatching(/not a timeout or a connection code/) })
  })

  it('a snapshot mismatch, and it is not', () => {
    expect(verdict(`${stuck}\nError: Snapshot \`access matrix 1\` mismatched`)).toMatchObject({ stuck: false })
  })

  it('a test of the app project failed, and it is not', () => {
    expect(verdict(`${stuck}\n FAIL  |app| tests/meta/webhook.test.ts > something real`)).toMatchObject({ stuck: false, why: expect.stringMatching(/app project/) })
  })

  it('a request hanging (a long wait, or the watchdog), and it is not', () => {
    expect(verdict(`${stuck}\n[access] test failed with a request still waiting: GET /rest/v1/x  (waiting 40 s)`)).toMatchObject({ stuck: false, why: expect.stringMatching(/waited 40 s/) })
    expect(verdict(`${stuck}\n[access] no answer for 90 s; waiting on: GET /rest/v1/x`)).toMatchObject({ stuck: false, why: expect.stringMatching(/watchdog/) })
  })

  it('no timeout at all, and it is not', () => {
    // Both forms gone: the error line, and the failed test's line with its duration
    const untimed = stuck.replace(/Error: Test timed out in \d+ms\.?/g, 'Error: Database connection error.').replace(/^(\s*×\s+.*?)\d{6,}ms\s*$/gm, '$1 12ms')
    expect(verdict(untimed)).toMatchObject({ stuck: false, why: expect.stringMatching(/no test timed out/) })
  })

  it('a log cut off before its summary, and it is not', () => {
    expect(verdict(stuck.replace(/^\s*Test Files\s.*$/m, ''))).toMatchObject({ stuck: false, why: expect.stringMatching(/summary/) })
  })
})
