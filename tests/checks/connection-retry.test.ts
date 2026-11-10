import { afterEach, describe, expect, it, vi } from 'vitest'
import { withConnectionRetry } from '../harness/helpers'

/**
 * THE HARNESS RETRIES CONNECTION ERRORS, AND ONLY THEM (tests/harness/helpers.ts,
 * 2026-11-10). The owner's two conditions, held here: every retry is logged,
 * one line each; and only PGRST000–003 are retried, bounded. A 4xx, a 500, a
 * 503 without a connection code: answered at once, never retried.
 */

const answer = (status: number, code?: string) => new Response(JSON.stringify(code ? { code, message: 'x' } : { message: 'x' }), { status })

function calls(responses: Response[]) {
  let n = 0
  const run = vi.fn(async () => responses[Math.min(n++, responses.length - 1)].clone())
  return run
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('a connection-type 503', () => {
  it('is retried, and each retry logged, until the answer comes', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = calls([answer(503, 'PGRST001'), answer(503, 'PGRST001'), answer(200)])
    const response = await withConnectionRetry('POST /rpc/normalize_branch_name', run)
    expect(response.status).toBe(200)
    expect(run).toHaveBeenCalledTimes(3)
    expect(warn.mock.calls.map((c) => c[0])).toEqual([
      '[harness] connection retry 1/2 after PGRST001: POST /rpc/normalize_branch_name',
      '[harness] connection retry 2/2 after PGRST001: POST /rpc/normalize_branch_name',
    ])
  })

  it('PGRST001–003 are bounded at three attempts: the last answer is returned as it is', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const code of ['PGRST001', 'PGRST002', 'PGRST003']) {
      const run = calls([answer(503, code)])
      const response = await withConnectionRetry('GET /x', run)
      expect(response.status).toBe(503)
      expect(run).toHaveBeenCalledTimes(3)
    }
  })

  it('PGRST000 (PostgREST still reconnecting) is waited out for at most fifteen attempts', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const run = calls([answer(503, 'PGRST000')])
    const pending = withConnectionRetry('GET /x', run)
    await vi.runAllTimersAsync()
    const response = await pending
    expect(response.status).toBe(503)
    expect(run).toHaveBeenCalledTimes(15)
    expect(warn).toHaveBeenCalledTimes(14)
  })
})

describe('anything else is never retried', () => {
  it('a 4xx, a 500, and a 503 without a connection code are answered at once, with no log', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    for (const response of [answer(400, '23505'), answer(409, '23505'), answer(500, 'XX000'), answer(503)]) {
      const run = calls([response])
      expect((await withConnectionRetry('POST /x', run)).status).toBe(response.status)
      expect(run).toHaveBeenCalledTimes(1)
    }
    expect(warn).not.toHaveBeenCalled()
  })
})
