import 'server-only'
import { randomInt } from 'node:crypto'
import { connectGraph } from '@/lib/meta/connect'

/**
 * WHATSAPP EMBEDDED SIGNUP, THE META SIDE (.scratch/whatsapp-go-and-strings.md;
 * decided 2026-11-09): the ordinary signup, never coexistence. The clinic
 * connects a NEW number for the bot; its own number and its WhatsApp Business
 * app stay as they are. A number connected here is taken off the app, which is
 * what the clinic is told before it clicks.
 *
 * The popup (Meta's JavaScript SDK, on our channels page) hands the browser a
 * code, the WABA id and the phone number id. The browser is never trusted on
 * the ids: the server exchanges the code, checks the token, and confirms the
 * WABA and the number against what the token itself can see.
 *
 * NEVER LOGGED: the token, the code, the PIN. Logged: Meta's ids (WABA and
 * number), states and error codes.
 */

/** The WhatsApp configuration's permissions: all must be granted, nothing more is asked */
export const WHATSAPP_REQUIRED_SCOPES = ['whatsapp_business_management', 'whatsapp_business_messaging'] as const

export type WhatsAppConfig = { appId: string; appSecret: string; configId: string }

/** null when anything is unset: the WhatsApp connect is not offered */
export function whatsappConfig(): WhatsAppConfig | null {
  const appId = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  const configId = process.env.META_WHATSAPP_CONFIG_ID
  if (!appId || !appSecret || !configId) return null
  return { appId, appSecret, configId }
}

export type WhatsAppNumber = {
  id: string
  displayPhoneNumber: string | null
  verifiedName: string | null
  /** APPROVED once WhatsApp has reviewed the display name; anything else is still pending (replies work meanwhile) */
  nameStatus: string | null
}

const NUMBER_FIELDS = 'id,display_phone_number,verified_name,name_status'

/**
 * The WABA's numbers as the token sees them: null when the token cannot read
 * the WABA at all (it is then not this token's WABA, whatever the browser said).
 */
export async function wabaNumbers(wabaId: string, token: string): Promise<WhatsAppNumber[] | null> {
  const answer = await connectGraph(`${wabaId}/phone_numbers`, { token, query: { fields: NUMBER_FIELDS, limit: '100' } })
  if (!answer.ok) {
    console.warn('[whatsapp/connect] phone_numbers refused', { wabaId, status: answer.status, code: answer.code })
    return null
  }
  const rows = Array.isArray(answer.body.data) ? (answer.body.data as Record<string, unknown>[]) : []
  return rows.flatMap((row) =>
    typeof row.id === 'string'
      ? [
          {
            id: row.id,
            displayPhoneNumber: typeof row.display_phone_number === 'string' ? row.display_phone_number : null,
            verifiedName: typeof row.verified_name === 'string' ? row.verified_name : null,
            nameStatus: typeof row.name_status === 'string' ? row.name_status : null,
          },
        ]
      : []
  )
}

/** A new two-step verification PIN for a number we register: six digits, the business's to keep */
export function newPin() {
  return String(randomInt(0, 1_000_000)).padStart(6, '0')
}

/**
 * Registers the number with the Cloud API, setting its two-step PIN:
 * POST /{phone-number-id}/register. Without it the number cannot send. The
 * PIN goes in the body and never into a log or an error.
 */
export async function registerNumber(phoneNumberId: string, token: string, pin: string): Promise<{ ok: true } | { ok: false; status: number | null; code: number | null }> {
  const answer = await connectGraph(`${phoneNumberId}/register`, { token, form: { messaging_product: 'whatsapp', pin } })
  if (answer.ok && answer.body.success !== false) {
    console.info('[whatsapp/connect] number registered', { phoneNumberId })
    return { ok: true }
  }
  const status = answer.ok ? null : answer.status
  const code = answer.ok ? null : answer.code
  console.warn('[whatsapp/connect] register refused', { phoneNumberId, status, code })
  return { ok: false, status, code }
}
