import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * THE EMBEDDED SIGNUP VERSION IS PINNED, AND THIS TEST IS THE PIN (2026-11-15).
 *
 * The popup is opened with extras { version: 'v4' } and nothing else. Meta's
 * Embedded Signup v5 (20 October 2026) turns WhatsApp Business app onboarding
 * (coexistence) ON BY DEFAULT: "featureType is not needed. To opt out, add
 * { name: 'whatsapp_business_app_onboarding', enabled: false } to features."
 * A bump to v5, or a featureType added in passing, changes the flow every
 * clinic sees, the Meta App Review reviewer included, away from the one
 * filmed for the submission. So the exact options FB.login receives are
 * asserted here, whole: changing them fails this test, on purpose.
 *
 * Changing the version is a decision, not a chore: the owner's, after the
 * App Review, with the coexistence design (.scratch/coexistence-design.md)
 * and a new screencast if the flow changes. Then this test changes with it.
 */

const PINNED_LOGIN_OPTIONS = {
  config_id: 'CONFIG-1',
  response_type: 'code',
  override_default_response_type: true,
  extras: { version: 'v4' },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

async function loginOptions() {
  const login = vi.fn((callback: (response: { authResponse?: { code?: string } | null }) => void, options: Record<string, unknown>) => {
    void options // read back from mock.calls below
    callback({ authResponse: null })
  })
  vi.stubGlobal('window', { FB: { init: vi.fn(), login }, addEventListener: vi.fn(), removeEventListener: vi.fn() })
  // Fresh each time: the module keeps the SDK it loaded first
  vi.resetModules()
  const { launchWhatsAppSignup } = await import('@/lib/meta/whatsapp-signup')
  const outcome = await launchWhatsAppSignup({ appId: 'APP-1', configId: 'CONFIG-1' })
  expect(outcome).toEqual({ kind: 'cancelled' })
  expect(login).toHaveBeenCalledTimes(1)
  return login.mock.calls[0][1]
}

describe('the WhatsApp Embedded Signup popup', () => {
  it('is opened with exactly the pinned options: Embedded Signup v4, nothing added', async () => {
    expect(await loginOptions()).toStrictEqual(PINNED_LOGIN_OPTIONS)
  })

  it('never asks for coexistence, by featureType or by features', async () => {
    const options = await loginOptions()
    const extras = options.extras as Record<string, unknown>
    expect(extras.version).toBe('v4')
    expect(extras).not.toHaveProperty('featureType')
    expect(extras).not.toHaveProperty('features')
    expect(JSON.stringify(options)).not.toContain('whatsapp_business_app_onboarding')
  })
})
