/**
 * WHATSAPP EMBEDDED SIGNUP, THE BROWSER SIDE: Meta's popup, from a button on
 * our channels page (the clinic is signed in and on one client's page, so
 * there is no state to carry). Built on the code Meta's builder gave
 * (.scratch/whatsapp-go-and-strings.md, 2026-11-09), kept as given:
 *   - the message listener: only https://www.facebook.com, only
 *     WA_EMBEDDED_SIGNUP;
 *   - FB.login with config_id, response_type 'code' and
 *     override_default_response_type true. Those two together are what yields
 *     a System User token rather than a user token: NEVER CHANGE THEM;
 *   - extras {"version":"v4"} and nothing else: no featureType. With
 *     "whatsapp_business_app_onboarding" it is coexistence, which we do not do.
 * The popup reports two things on two channels, in either order: the code
 * (FB.login's callback) and the WABA and number ids (the message event). Both
 * are awaited, then handed to the server, which trusts none of it until it
 * has checked it (src/lib/actions/whatsapp-connect.ts).
 */

import type { WhatsAppSignup } from '@/lib/types/whatsapp-connect'

type FacebookSdk = {
  init(options: { appId: string; version: string; xfbml?: boolean; cookie?: boolean }): void
  login(callback: (response: { authResponse?: { code?: string } | null }) => void, options: Record<string, unknown>): void
}

declare global {
  interface Window {
    FB?: FacebookSdk
    fbAsyncInit?: () => void
  }
}

const SDK_URL = 'https://connect.facebook.net/en_US/sdk.js'
const SDK_VERSION = 'v26.0'
/** How long after the popup's code to wait for its ids before giving up */
const IDS_WAIT_MS = 15_000

let sdk: Promise<FacebookSdk> | null = null

/** Meta's SDK, loaded once, on the first click */
function loadSdk(appId: string): Promise<FacebookSdk> {
  sdk ??= new Promise<FacebookSdk>((resolve, reject) => {
    if (window.FB) {
      window.FB.init({ appId, version: SDK_VERSION, xfbml: false })
      resolve(window.FB)
      return
    }
    window.fbAsyncInit = () => {
      window.FB!.init({ appId, version: SDK_VERSION, xfbml: false })
      resolve(window.FB!)
    }
    const script = document.createElement('script')
    script.src = SDK_URL
    script.async = true
    script.defer = true
    script.crossOrigin = 'anonymous'
    script.onerror = () => {
      sdk = null
      reject(new Error('the Facebook SDK did not load'))
    }
    document.body.appendChild(script)
  })
  return sdk
}

export type SignupOutcome = { kind: 'done'; signup: WhatsAppSignup } | { kind: 'cancelled' } | { kind: 'failed'; why: string }

/** Opens Meta's signup popup and resolves with what it reported */
export async function launchWhatsAppSignup({ appId, configId }: { appId: string; configId: string }): Promise<SignupOutcome> {
  let FB: FacebookSdk
  try {
    FB = await loadSdk(appId)
  } catch {
    return { kind: 'failed', why: 'sdk' }
  }

  return new Promise<SignupOutcome>((resolve) => {
    let code: string | null = null
    let ids: { wabaId: string; phoneNumberId: string } | null = null
    let settled = false
    let wait: ReturnType<typeof setTimeout> | null = null

    const finish = (outcome: SignupOutcome) => {
      if (settled) return
      settled = true
      window.removeEventListener('message', listener)
      if (wait) clearTimeout(wait)
      resolve(outcome)
    }
    const maybeDone = () => {
      if (code && ids) finish({ kind: 'done', signup: { code, ...ids } })
    }

    // Meta's listener, as given
    const listener = (event: MessageEvent) => {
      if (event.origin !== 'https://www.facebook.com') return
      try {
        const data = JSON.parse(event.data)
        if (data.type === 'WA_EMBEDDED_SIGNUP') {
          if (data.event === 'FINISH' || data.event === 'FINISH_ONLY_WABA') {
            const wabaId = data.data?.waba_id
            const phoneNumberId = data.data?.phone_number_id
            if (typeof wabaId === 'string' && typeof phoneNumberId === 'string') {
              ids = { wabaId, phoneNumberId }
              maybeDone()
            } else {
              finish({ kind: 'failed', why: 'no_number' })
            }
          } else if (data.event === 'CANCEL') {
            finish({ kind: 'cancelled' })
          } else if (data.event === 'ERROR') {
            finish({ kind: 'failed', why: 'signup_error' })
          }
        }
      } catch {
        // Not Meta's JSON: some other message from facebook.com; ignored
      }
    }
    window.addEventListener('message', listener)

    // Meta's login callback, as given: the code goes to our server, never anywhere else
    const fbLoginCallback = (response: { authResponse?: { code?: string } | null }) => {
      if (response.authResponse?.code) {
        code = response.authResponse.code
        maybeDone()
        // The ids normally arrive first; give them a moment when they have not
        if (!settled) wait = setTimeout(() => finish({ kind: 'failed', why: 'no_ids' }), IDS_WAIT_MS)
      } else {
        // The popup closed without a code
        finish({ kind: 'cancelled' })
      }
    }

    FB.login(fbLoginCallback, {
      config_id: configId,
      response_type: 'code',
      override_default_response_type: true,
      extras: { version: 'v4' },
    })
  })
}
