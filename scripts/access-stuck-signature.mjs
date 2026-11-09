// Whether a failed run's log is the access project's STUCK STATE and nothing
// else (tests/harness/access-fetch.ts, "THE STUCK STATE"; AGENTS.md, the
// interim rerun rule). Decided by this script, never by eye: a stuck run is
// the one failure that may be rerun, and only because it proves nothing.
//
//   node scripts/access-stuck-signature.mjs <log>   prints the verdict and why;
//                                                   exit 0 stuck, 1 not stuck
//
// STUCK only when every one of these holds; anything else is NOT STUCK, and
// a NOT STUCK failure blocks the commit:
//   1. the log is whole: it ends with vitest's summary. A log cut off before
//      its failures are explained cannot show that none of them is real;
//   2. no test of the app project failed;
//   3. something in the access project failed;
//   4. every error is a timeout or a connection code (PGRST000–003,
//      "Database connection error"): one real assertion failure anywhere,
//      a snapshot mismatch, any other error, and it is not the stuck state;
//   5. at least one test timed out;
//   6. the state's positive mark: at least 3 `[access] slow reconnect` lines
//      (tests/harness/access-fetch.ts, added 2026-11-09). Without it a stuck
//      run and a test grown too slow for its limit look alike, so a log
//      without the mark is never called stuck;
//   7. no request left waiting longer than 15 s, and the 90 s watchdog never
//      fired: no single request hanging.
// Tested against the ten measured runs of 2026-11-09 and two full-check
// failures (tests/checks/access-stuck-signature.test.ts). None of those twelve
// is a pure stuck run, and the tests hold that none is called one.

import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const CONNECTION = /PGRST00[0-3]|Database connection error/
const TIMEOUT = /^Error: Test timed out in \d+ms\.?$/
const ERROR_LINE = /^(?:[A-Z][A-Za-z]*Error|Error)(?:\s*\[[^\]]*\])?: .*/
/** A failed test, as either reporter prints it: verbose `× … 180012ms`, or the summary's ` FAIL  |project| …` */
const FAILED = /^\s*(?:×|FAIL)\s+\|(app|access)\|/
const VERBOSE_FAILED = /^\s*×\s+(.*?)(\d+)ms\s*$/
const WAIT = /\(waiting (\d+) s\)/g
const WATCHDOG = /\[access\] no answer for \d+ s/
const SLOW_RECONNECT = /\[access\] slow reconnect: \d+ s before an answer/g
const SUMMARY = /^\s*Test Files\s/m
const MARKS_NEEDED = 3
/** A verbose-reporter failure this long is a timeout even in a log cut off before its error printed */
const TIMED_OUT_MS = 100_000

export function classify(log) {
  const lines = log.split('\n')
  const reasons = []
  const fail = (why) => ({ stuck: false, why })

  if (!SUMMARY.test(log)) return fail('the log ends before vitest’s summary: its failures are not all explained')

  const failed = lines.filter((l) => FAILED.test(l))
  if (failed.some((l) => FAILED.exec(l)[1] === 'app')) return fail('a test of the app project failed')

  const verboseFails = lines.map((l) => VERBOSE_FAILED.exec(l)).filter(Boolean)
  if (failed.length === 0 && verboseFails.length === 0) return fail('nothing in the access project failed')

  const errors = lines.map((l) => l.trim()).filter((l) => ERROR_LINE.test(l))
  const real = errors.filter((l) => !TIMEOUT.test(l) && !CONNECTION.test(l))
  if (real.length > 0) return fail(`a failure that is not a timeout or a connection code: ${real[0].slice(0, 160)}`)

  const timedOut = errors.some((l) => TIMEOUT.test(l)) || verboseFails.some((m) => Number(m[2]) >= TIMED_OUT_MS)
  if (!timedOut) return fail('no test timed out')
  reasons.push('every error is a timeout or a connection code')

  const marks = [...log.matchAll(SLOW_RECONNECT)].length
  if (marks < MARKS_NEEDED) return fail(`${marks} slow-reconnect mark(s), ${MARKS_NEEDED} needed: no positive sign of the stuck state`)
  reasons.push(`${marks} slow reconnects`)

  const waits = [...log.matchAll(WAIT)].map((m) => Number(m[1]))
  const longest = waits.length ? Math.max(...waits) : 0
  if (longest > 15) return fail(`a request waited ${longest} s: one request hanging, not every request slow`)

  if (WATCHDOG.test(log)) return fail('the 90 s watchdog fired: a single request hung')
  reasons.push('no watchdog')

  return { stuck: true, why: reasons.join('; ') }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const path = process.argv[2]
  if (!path) {
    console.error('usage: node scripts/access-stuck-signature.mjs <log>')
    process.exit(2)
  }
  const { stuck, why } = classify(readFileSync(path, 'utf8'))
  console.log(`${stuck ? 'STUCK' : 'NOT STUCK'}: ${why}`)
  process.exit(stuck ? 0 : 1)
}
