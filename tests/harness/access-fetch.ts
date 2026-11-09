/**
 * EVERY REQUEST THE ACCESS PROJECT MAKES GOES THROUGH HERE (27 October 2026).
 *
 * The access tests fire hundreds of statements the database refuses on
 * purpose, over the one connection PGlite has, and that connection sometimes
 * wedges under a refused statement (pglite#958). Three things answer that,
 * and they used to be copied into each access file: the matrix test had all
 * three, channel-secrets.test.ts copied the queue and the retry and not the
 * watchdog, and the first real hang there (27 October, a 120 s timeout)
 * named nothing. So they live once, here, installed on the global fetch by
 * the access project's setup file (access-setup.ts): a file in tests/access
 * cannot make a request that misses them, and instrument.test.ts fails the
 * day one could.
 *
 *   ONE REQUEST AT A TIME. A refused statement takes down whatever runs
 *   beside it (22 October: a fixture insert issued in parallel with refused
 *   deletes failed with PGRST000 and stayed failed). Serialised, nothing
 *   ever runs beside a refusal.
 *
 *   CONNECTION ERRORS RETRIED. In this harness a refused statement often
 *   answers 503 PGRST001 instead of its own error, and the call after it
 *   sometimes fails too, though nothing was wrong with it. A connection-type
 *   answer (503 PGRST000–003) means the statement never ran, so a retry
 *   can't run anything twice; a statement the database really refuses
 *   answers the same every time.
 *
 *   THE STATEMENT IN FLIGHT IS NAMED. vitest's timeout says nothing about
 *   which request hung. A request with no answer after WATCHDOG_MS is
 *   printed, and a test that fails prints whatever is still waiting.
 *   WATCHDOG_MS sits below every timeout of the access project
 *   (instrument.test.ts holds it there), so the print comes first.
 *
 * THE STUCK STATE (measured 2026-11-09; read this before diagnosing a failed
 * access run). Some runs of the access project switch, partway through, into
 * a state they never leave: EVERY request takes about 10 s, which is the
 * PGRST000 wait above used up in full, call after call. Its signature:
 *   - tests time out one after another, each at its own limit;
 *   - the `[access] test failed with a request still waiting` lines show
 *     waits of about 9–13 s, never one long wait;
 *   - `[access] slow reconnect` lines, one per request that took 8 s or
 *     more through the reconnect wait (added 2026-11-09 as the state's
 *     positive mark: the waiting lines alone cannot tell it from a test
 *     grown too slow for its limit);
 *   - the watchdog's `no answer for 90 s` line never prints: no single
 *     request hangs, every request is slow;
 *   - the files after it then fail on PGRST000 and "Seeding failed:
 *     Database connection error", which reads as a connection flake and is
 *     the cascade, not the cause.
 * Ten runs of the access project alone, nothing changed between them: 3
 * went stuck, 7 did not. In the 7, the slowest single test took 24 s and the
 * six channel-secrets tables 86–96 s together; in the 3, every test after
 * the switch failed whatever its size. SO TEST SIZE IS NOT WHAT FAILS:
 * splitting a test, or raising its limit, changes nothing for it. Twice
 * before this was diagnosed as something else (a connection flake; then a
 * cost growing with each table).
 *
 * THE OTHER WAY A RUN FAILS, which is not this state: a test outgrowing its
 * limit. It times out with no `slow reconnect` marks and no cascade (the
 * tests after it pass): a real failure, cured by splitting the test, never
 * by rerunning (2026-11-09: channel-secrets' six tables in one test, over
 * 120 s in a full run). Marks plus a cascade is the stuck state; a timeout
 * without them is a test too big for its limit. scripts/access-stuck-
 * signature.mjs tells them apart; read every failed access run through it.
 * All 3 switched inside channel-secrets.test.ts, at a different table each
 * time (after 1, 2 and 3 of its tables had passed); the files ran in a
 * different order from run to run. It is the file that fires refusals
 * densest (30 in about 14 s per table), which may be why, or may not.
 * NOT KNOWN: what puts a run into the state (nothing in the code under test
 * does), whether it is PostgREST's pool or pglite-socket that stops
 * reconnecting, and why it never recovers. A proposed mechanism, unproven
 * and parked (pglite-socket refusing every new connection because its one
 * slot is still counted as taken), and what would test it: AGENTS.md. Asserting refusals inside the database (test_sqlstate),
 * where the connection never sees a refusal, is the planned cure.
 */

export const WATCHDOG_MS = 90_000

/**
 * A request that spent this long getting an answer through the reconnect
 * wait is logged as `[access] slow reconnect`. In a good run that is rare;
 * in the stuck state nearly every request is one. It is the stuck state's
 * positive mark, which scripts/access-stuck-signature.mjs counts: without it
 * a stuck run and a test grown too slow for its limit look alike.
 */
export const SLOW_RECONNECT_MS = 8_000

const MARK = Symbol.for('advertema.access-fetch')

let inFlight: { request: string; since: number } | null = null
let last = ''

/** The request most recently started, for a fixture's error message */
export const lastRequest = () => last

/** The request still waiting for its answer, if any, and for how long */
export function requestInFlight() {
  return inFlight ? `${inFlight.request} (waiting ${Math.round((Date.now() - inFlight.since) / 1000)} s)` : null
}

const describeRequest = (input: RequestInfo | URL, init?: RequestInit) =>
  `${init?.method ?? 'GET'} ${String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/, '')} ${String(init?.body ?? '').slice(0, 160)}`

export function instrumented(underlying: typeof fetch): typeof fetch {
  const retrying: typeof fetch = async (input, init) => {
    last = describeRequest(input, init)
    inFlight = { request: last, since: Date.now() }
    const watchdog = setTimeout(() => console.error(`[access] no answer for ${WATCHDOG_MS / 1000} s; waiting on: ${last}`), WATCHDOG_MS)
    const started = Date.now()
    let retried = false
    const slow = () => {
      const took = Date.now() - started
      if (retried && took >= SLOW_RECONNECT_MS) console.error(`[access] slow reconnect: ${Math.round(took / 1000)} s before an answer to ${last}`)
    }
    try {
      for (let attempt = 1; ; attempt += 1) {
        const response = await underlying(input, init)
        if (response.status !== 503) {
          slow()
          return response
        }
        const code = /"code"\s*:\s*"(PGRST00[0-3])"/.exec(await response.clone().text())?.[1]
        // PGRST000: PostgREST has no connection yet and is backing off (seen
        // lasting over 150 ms): waited out for up to ~10 s. A refusal never
        // answers PGRST000, so this can't hide one. PGRST001–003: twice more.
        const limit = code === 'PGRST000' ? 15 : code ? 3 : 1
        if (attempt >= limit) {
          slow()
          return response
        }
        retried = true
        await new Promise((resolve) => setTimeout(resolve, code === 'PGRST000' ? Math.min(200 * attempt, 1000) : 50 * attempt))
      }
    } finally {
      clearTimeout(watchdog)
      inFlight = null
    }
  }
  let queue: Promise<unknown> = Promise.resolve()
  const oneAtATime = ((input, init) => {
    const run = queue.then(() => retrying(input, init))
    queue = run.catch(() => undefined)
    return run
  }) as typeof fetch & { [MARK]?: true }
  oneAtATime[MARK] = true
  return oneAtATime
}

export const isInstrumented = (candidate: unknown) => typeof candidate === 'function' && (candidate as { [MARK]?: true })[MARK] === true
