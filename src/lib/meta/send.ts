import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * SENDING, ONE FUNCTION, ONE PLACE (.scratch/whatsapp-send-design.md §3).
 *
 * POST https://graph.facebook.com/v25.0/{phone_number_id}/messages with the
 * channel's token from channel_secrets (service role only). Text only: no
 * templates, no media, no buttons, no lists, no business-initiated messages;
 * those are a separate decision and some need Meta's approval. A reply that
 * cannot go as plain text is reported and not sent: no fallback shape is
 * invented here.
 *
 * The 24-hour window: WhatsApp allows a free-form message only within 24
 * hours of the customer's last message. Every reply answers an inbound
 * message, so we are inside it, except when a retry or a slow model call
 * lands late. Meta answers that with error 131047; it is its own result and
 * is never retried, because a retry fails the same way. Everything else is
 * tried once more, then given up and reported.
 *
 * NEVER LOGGED: the message body, the recipient's number, the token. Logged:
 * the channel id, the wamid, the status code, the error code. The same
 * discipline as the receiving side, in the other direction.
 */

const GRAPH = 'https://graph.facebook.com/v25.0'
/** WhatsApp: a free-form message outside the 24-hour customer service window */
export const OUTSIDE_WINDOW_CODE = 131047
/** WhatsApp's limit for a text body */
export const MAX_TEXT_LENGTH = 4096
const ATTEMPT_TIMEOUT_MS = 15_000

export type SendResult =
  /** Delivered to Meta; `messageId` is the outbound wamid it answered with */
  | { kind: 'sent'; messageId: string | null }
  /** Error 131047: too late for a free-form message. Not retried */
  | { kind: 'outside_window'; status: number }
  /** Meta refused or the request failed, after the one retry */
  | { kind: 'failed'; status: number | null; code: number | null; attempts: number }
  /** The channel has no token, or no phone_number_id to send from: nothing was attempted */
  | { kind: 'not_configured'; missing: 'token' | 'phone_number_id' }
  /** Empty, or longer than WhatsApp allows: nothing was attempted */
  | { kind: 'unsendable'; reason: 'empty' | 'too_long' }

export async function sendWhatsAppText({
  supabase,
  channelId,
  to,
  body,
}: {
  /** The service-role client: channel_secrets has no policy for anyone else */
  supabase: SupabaseClient
  channelId: string
  /** The recipient as Meta gave it (the inbound message's `from`) */
  to: string
  body: string
}): Promise<SendResult> {
  const text = body.trim()
  if (!text) return reported(channelId, { kind: 'unsendable', reason: 'empty' })
  if (text.length > MAX_TEXT_LENGTH) return reported(channelId, { kind: 'unsendable', reason: 'too_long' })

  const { data: secret, error } = await supabase
    .from('channel_secrets')
    .select('access_token, channels(external_id)')
    .eq('channel_id', channelId)
    .maybeSingle<{ access_token: string; channels: { external_id: string | null } | null }>()
  if (error) throw error
  if (!secret?.access_token) return reported(channelId, { kind: 'not_configured', missing: 'token' })
  const phoneNumberId = secret.channels?.external_id
  if (!phoneNumberId) return reported(channelId, { kind: 'not_configured', missing: 'phone_number_id' })

  const request = {
    method: 'POST',
    headers: { Authorization: `Bearer ${secret.access_token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to, type: 'text', text: { body: text } }),
  }

  let last: { status: number | null; code: number | null } = { status: null, code: null }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response
    try {
      response = await fetch(`${GRAPH}/${phoneNumberId}/messages`, { ...request, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) })
    } catch (cause) {
      // The request itself failed (network, timeout): nothing to read, one more try
      console.warn('[whatsapp/send] request failed', { channelId, attempt, cause: cause instanceof Error ? cause.name : String(cause) })
      last = { status: null, code: null }
      continue
    }
    const answer = (await response.json().catch(() => ({}))) as {
      messages?: { id?: string }[]
      error?: { code?: number }
    }
    if (response.ok) {
      const messageId = answer.messages?.[0]?.id ?? null
      console.info('[whatsapp/send] sent', { channelId, messageId, status: response.status })
      return { kind: 'sent', messageId }
    }
    const code = typeof answer.error?.code === 'number' ? answer.error.code : null
    if (code === OUTSIDE_WINDOW_CODE) {
      return reported(channelId, { kind: 'outside_window', status: response.status })
    }
    last = { status: response.status, code }
    console.warn('[whatsapp/send] refused', { channelId, attempt, status: response.status, code })
  }
  return reported(channelId, { kind: 'failed', ...last, attempts: 2 })
}

/** Every outcome that is not a send is written to the log by kind, with nothing of the message in it */
function reported<T extends Exclude<SendResult, { kind: 'sent' }>>(channelId: string, result: T): T {
  console.warn(`[whatsapp/send] ${result.kind}`, { channelId, ...result })
  return result
}
