import { beforeEach, vi } from 'vitest'
import { instrumented, requestInFlight } from './access-fetch'
import { connectionRetriesHandledAbove } from './helpers'

// The access project only, after setup.ts: the queue, the retry and the
// watchdog wrap the harness's own fetch, so every client any access file
// creates goes through them (access-fetch.ts says why)
// The instrument retries connection errors; harnessFetch's own retry stands down, so none is retried twice
connectionRetriesHandledAbove()
vi.stubGlobal('fetch', instrumented(globalThis.fetch))

// A test that fails (a timeout above all) says what it was still waiting on
beforeEach(({ onTestFailed }) => {
  onTestFailed(() => {
    const waiting = requestInFlight()
    if (waiting) console.error(`[access] test failed with a request still waiting: ${waiting}`)
  })
})
