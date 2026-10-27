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
 */

export const WATCHDOG_MS = 90_000

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
    try {
      for (let attempt = 1; ; attempt += 1) {
        const response = await underlying(input, init)
        if (response.status !== 503) return response
        const code = /"code"\s*:\s*"(PGRST00[0-3])"/.exec(await response.clone().text())?.[1]
        // PGRST000: PostgREST has no connection yet and is backing off (seen
        // lasting over 150 ms): waited out for up to ~10 s. A refusal never
        // answers PGRST000, so this can't hide one. PGRST001–003: twice more.
        const limit = code === 'PGRST000' ? 15 : code ? 3 : 1
        if (attempt >= limit) return response
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
