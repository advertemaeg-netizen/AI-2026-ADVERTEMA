import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * SENDING, ONE LOOP, ONE PLACE (.scratch/whatsapp-send-design.md §3,
 * .scratch/messenger-instagram-design.md §6).
 *
 * WhatsApp: POST https://graph.facebook.com/v25.0/{phone_number_id}/messages.
 * Messenger: POST https://graph.facebook.com/v25.0/{page_id}/messages, as a
 * RESPONSE to the person's message (recipient.id is their PSID). Both with
 * the channel's token from channel_secrets (service role only), in the
 * Authorization header and never the URL: Meta's own Messenger sample puts
 * the Page token in the query string, where it would reach access logs.
 *
 * Text only: no templates, no media, no buttons, no lists, no
 * business-initiated messages, no Messenger message tags; those are a
 * separate decision and some need Meta's approval or carry policy. A reply
 * that cannot go as plain text is reported and not sent: no fallback shape
 * is invented here.
 *
 * The window: both platforms allow a free-form message only within 24 hours
 * of the person's last message. Every reply answers an inbound message, so
 * we are inside it, except when a retry or a slow model call lands late.
 * WhatsApp answers that with error 131047, Messenger with error 10, subcode
 * 2018278 (Meta's Messenger error code table). It is its own result and is
 * never retried, because a retry fails the same way. Everything else is tried
 * once more, then given up and reported.
 *
 * NEVER LOGGED: the message body, the recipient (a number or a PSID), the
 * token. Logged: the channel id, the outbound message id, the status code,
 * the error code. The same discipline as the receiving side, in the other
 * direction.
 */

const GRAPH = 'https://graph.facebook.com/v25.0'
/** WhatsApp: a free-form message outside the 24-hour customer service window */
export const OUTSIDE_WINDOW_CODE = 131047
/** WhatsApp's limit for a text body */
export const MAX_TEXT_LENGTH = 4096
/** Messenger: error 10 with this subcode is a message sent outside the allowed window */
export const MESSENGER_OUTSIDE_WINDOW = { code: 10, subcode: 2018278 } as const
/**
 * Messenger's limit for message.text: "must be UTF-8 and less than 2000
 * characters" (Send API reference). Counted in UTF-16 units, which is never
 * fewer than characters, so the cap errs on the side of not sending.
 */
export const MESSENGER_MAX_TEXT_LENGTH = 1999
const ATTEMPT_TIMEOUT_MS = 15_000

export type SendResult =
  /** Delivered to Meta; `messageId` is the outbound id it answered with (a wamid, or Messenger's mid) */
  | { kind: 'sent'; messageId: string | null }
  /** Too late for a free-form message (WhatsApp 131047, Messenger 10/2018278). Not retried */
  | { kind: 'outside_window'; status: number }
  /** Meta refused or the request failed, after the one retry */
  | { kind: 'failed'; status: number | null; code: number | null; attempts: number }
  /** The channel has no token, or no business id to send from: nothing was attempted */
  | { kind: 'not_configured'; missing: 'token' | 'phone_number_id' | 'page_id' }
  /** Empty, or longer than the platform allows: nothing was attempted */
  | { kind: 'unsendable'; reason: 'empty' | 'too_long' }

type GraphError = { code?: number; error_subcode?: number }

type Platform = {
  /** The log's prefix: [whatsapp/send], [messenger/send] */
  log: string
  maxLength: number
  /** What is missing when the channel has no external_id */
  missingId: 'phone_number_id' | 'page_id'
  body(to: string, text: string): Record<string, unknown>
  /** The outbound id in an accepted answer */
  messageId(answer: Record<string, unknown>): string | null
  outsideWindow(error: GraphError): boolean
}

const WHATSAPP: Platform = {
  log: '[whatsapp/send]',
  maxLength: MAX_TEXT_LENGTH,
  missingId: 'phone_number_id',
  body: (to, text) => ({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  messageId: (answer) => {
    const messages = Array.isArray(answer.messages) ? (answer.messages as { id?: unknown }[]) : []
    return typeof messages[0]?.id === 'string' ? messages[0].id : null
  },
  outsideWindow: (error) => error.code === OUTSIDE_WINDOW_CODE,
}

const MESSENGER: Platform = {
  log: '[messenger/send]',
  maxLength: MESSENGER_MAX_TEXT_LENGTH,
  missingId: 'page_id',
  body: (to, text) => ({ recipient: { id: to }, messaging_type: 'RESPONSE', message: { text } }),
  messageId: (answer) => (typeof answer.message_id === 'string' ? answer.message_id : null),
  outsideWindow: (error) => error.code === MESSENGER_OUTSIDE_WINDOW.code && error.error_subcode === MESSENGER_OUTSIDE_WINDOW.subcode,
}

type SendArgs = {
  /** The service-role client: channel_secrets has no policy for anyone else */
  supabase: SupabaseClient
  channelId: string
  /** The recipient as Meta gave it: the inbound message's `from` (WhatsApp) or sender PSID (Messenger) */
  to: string
  body: string
}

export function sendWhatsAppText(args: SendArgs): Promise<SendResult> {
  return send(WHATSAPP, args)
}

export function sendMessengerText(args: SendArgs): Promise<SendResult> {
  return send(MESSENGER, args)
}

async function send(platform: Platform, { supabase, channelId, to, body }: SendArgs): Promise<SendResult> {
  const text = body.trim()
  if (!text) return reported(platform, channelId, { kind: 'unsendable', reason: 'empty' })
  if (text.length > platform.maxLength) return reported(platform, channelId, { kind: 'unsendable', reason: 'too_long' })

  const { data: secret, error } = await supabase
    .from('channel_secrets')
    .select('access_token, channels(external_id)')
    .eq('channel_id', channelId)
    .maybeSingle<{ access_token: string; channels: { external_id: string | null } | null }>()
  if (error) throw error
  if (!secret?.access_token) return reported(platform, channelId, { kind: 'not_configured', missing: 'token' })
  const businessId = secret.channels?.external_id
  if (!businessId) return reported(platform, channelId, { kind: 'not_configured', missing: platform.missingId })

  const request = {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(platform.body(to, text)),
  }

  let last: { status: number | null; code: number | null } = { status: null, code: null }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response
    try {
      response = await fetch(`${GRAPH}/${businessId}/messages`, { ...request, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) })
    } catch (cause) {
      // The request itself failed (network, timeout): nothing to read, one more try
      console.warn(`${platform.log} request failed`, { channelId, attempt, cause: cause instanceof Error ? cause.name : String(cause) })
      last = { status: null, code: null }
      continue
    }
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: GraphError }
    if (response.ok) {
      const messageId = platform.messageId(answer)
      console.info(`${platform.log} sent`, { channelId, messageId, status: response.status })
      return { kind: 'sent', messageId }
    }
    const graphError: GraphError = typeof answer.error === 'object' && answer.error !== null ? answer.error : {}
    if (platform.outsideWindow(graphError)) {
      return reported(platform, channelId, { kind: 'outside_window', status: response.status })
    }
    const code = typeof graphError.code === 'number' ? graphError.code : null
    last = { status: response.status, code }
    console.warn(`${platform.log} refused`, { channelId, attempt, status: response.status, code })
  }
  return reported(platform, channelId, { kind: 'failed', ...last, attempts: 2 })
}

/** Every outcome that is not a send is written to the log by kind, with nothing of the message in it */
function reported<T extends Exclude<SendResult, { kind: 'sent' }>>(platform: Platform, channelId: string, result: T): T {
  console.warn(`${platform.log} ${result.kind}`, { channelId, ...result })
  return result
}
