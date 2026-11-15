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

/** The same options, serialised before coexistence existed (9ac18ae): the flag-off path must produce these bytes */
const PINNED_LOGIN_OPTIONS_JSON = '{"config_id":"CONFIG-1","response_type":"code","override_default_response_type":true,"extras":{"version":"v4"}}'

/**
 * COEXISTENCE, OPT-IN ON v4 (2026-11-15). Only when the business chose its
 * WhatsApp Business app number, and only while META_WHATSAPP_COEXISTENCE is
 * on (the channels page decides): Meta's coexistence extras, still v4. Never
 * v5, which would make coexistence the default for everyone.
 */
const PINNED_COEXISTENCE_OPTIONS = {
  config_id: 'CONFIG-1',
  response_type: 'code',
  override_default_response_type: true,
  extras: { version: 'v4', featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' },
}

afterEach(() => {
  vi.unstubAllGlobals()
})

type Popup = { event?: Record<string, unknown>; code?: string }

/** Meta's popup, stood in for: optionally a WA_EMBEDDED_SIGNUP message event, then the login callback */
async function signup(options: { coexistence?: boolean } = {}, popup: Popup = {}) {
  let listener: ((event: { origin: string; data: string }) => void) | null = null
  const login = vi.fn((callback: (response: { authResponse?: { code?: string } | null }) => void, loginOptions: Record<string, unknown>) => {
    void loginOptions // read back from mock.calls below
    if (popup.event) listener?.({ origin: 'https://www.facebook.com', data: JSON.stringify({ type: 'WA_EMBEDDED_SIGNUP', ...popup.event }) })
    callback({ authResponse: popup.code ? { code: popup.code } : null })
  })
  vi.stubGlobal('window', {
    FB: { init: vi.fn(), login },
    addEventListener: vi.fn((_: string, fn: typeof listener) => (listener = fn)),
    removeEventListener: vi.fn(),
  })
  // Fresh each time: the module keeps the SDK it loaded first
  vi.resetModules()
  const { launchWhatsAppSignup } = await import('@/lib/meta/whatsapp-signup')
  const outcome = await launchWhatsAppSignup({ appId: 'APP-1', configId: 'CONFIG-1', ...options })
  expect(login).toHaveBeenCalledTimes(1)
  return { outcome, options: login.mock.calls[0][1] }
}

async function loginOptions(options: { coexistence?: boolean } = {}) {
  const { outcome, options: sent } = await signup(options)
  expect(outcome).toEqual({ kind: 'cancelled' })
  return sent
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

  it('without coexistence, passes FB.login byte for byte what it passed before coexistence existed', async () => {
    expect(JSON.stringify(await loginOptions())).toBe(PINNED_LOGIN_OPTIONS_JSON)
    expect(JSON.stringify(await loginOptions({ coexistence: false }))).toBe(PINNED_LOGIN_OPTIONS_JSON)
  })

  it('with coexistence chosen, asks for it on v4, never v5, never features', async () => {
    const options = await loginOptions({ coexistence: true })
    expect(options).toStrictEqual(PINNED_COEXISTENCE_OPTIONS)
    expect(JSON.stringify(options)).not.toContain('v5')
  })

  it('takes a coexistence finish, the WABA alone, when it asked for one', async () => {
    const { outcome } = await signup({ coexistence: true }, { event: { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '980198427658004' } }, code: 'CODE-1' })
    expect(outcome).toEqual({ kind: 'done', signup: { code: 'CODE-1', wabaId: '980198427658004', phoneNumberId: null, coexistence: true } })
  })

  it('refuses a coexistence finish it did not ask for', async () => {
    const { outcome } = await signup({}, { event: { event: 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING', data: { waba_id: '980198427658004' } }, code: 'CODE-1' })
    expect(outcome).toEqual({ kind: 'failed', why: 'unexpected_coexistence' })
  })

  it('still finishes the ordinary signup with both ids', async () => {
    const { outcome } = await signup({}, { event: { event: 'FINISH', data: { waba_id: '111111', phone_number_id: '222222' } }, code: 'CODE-1' })
    expect(outcome).toEqual({ kind: 'done', signup: { code: 'CODE-1', wabaId: '111111', phoneNumberId: '222222' } })
  })
})
