/**
 * WHATSAPP COEXISTENCE: THE SWITCH (2026-11-15, branch coexistence).
 *
 * A business keeps its number on the WhatsApp Business app and adds the
 * Cloud API to it (Meta: "onboarding business app users"). Everything for it
 * is behind META_WHATSAPP_COEXISTENCE, which is OFF unless it is exactly
 * "on":
 *   - the Embedded Signup popup is opened exactly as today (the options are
 *     pinned by tests/meta/whatsapp-signup-version.test.ts);
 *   - the server refuses a coexistence signup;
 *   - the four coexistence webhook fields (smb_message_echoes, history,
 *     smb_app_state_sync, and account_update's coexistence events) are read
 *     and dropped, nothing written (tests/meta/coexistence-off.test.ts).
 *
 * TURN IT ON ONLY AFTER the four fields are subscribed in the App Dashboard
 * (after Meta's App Review, never before: they are app-wide and would reach
 * the review clinic). History and contacts can be requested once, within 24
 * hours of onboarding: a business onboarded while the fields are not
 * subscribed loses both, for good, unless it offboards and starts again.
 *
 * Isomorphic: no server-only import. The browser is told the flag by the
 * channels page (a prop), never reads the environment itself.
 */

export function coexistenceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.META_WHATSAPP_COEXISTENCE === 'on'
}

/** The 24 hours Meta gives for the one-shot history and contacts requests, from onboarding */
export const SYNC_WINDOW_MS = 24 * 60 * 60 * 1000

/**
 * PRICING (Meta's coexistence page, "Pricing", fetched 2026-11-15:
 * developers.facebook.com/documentation/business-messaging/whatsapp/
 * embedded-signup/onboarding-business-app-users/): "messages sent by the
 * business via the WhatsApp Business app will continue to be free, but
 * messages sent via Cloud API will be subject to Cloud API pricing." So a
 * reply from the business's phone does not use the number's 1,000 free
 * service messages a month; only what Mudrik sends does. A budget counter
 * counts our sends' statuses (their `pricing`), never smb_message_echoes.
 */

/** Meta's error when the business chose not to share its chat history ("cannot be changed later") */
export const HISTORY_DECLINED_CODE = 2593109
