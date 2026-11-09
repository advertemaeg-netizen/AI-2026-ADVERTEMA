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
/**
 * Messenger and Instagram: error 10 with either subcode is a message sent
 * outside the allowed window. Meta's Messenger error table lists both with
 * the same meaning and does not say which platform returns which, so both
 * are the window on both (decided 2026-11-04: it removes a guess).
 */
export const MESSENGER_OUTSIDE_WINDOW = { code: 10, subcodes: [2018278, 2534022] } as const
/**
 * Messenger's limit for message.text: "must be UTF-8 and less than 2000
 * characters" (Send API reference). Counted in UTF-16 units, which is never
 * fewer than characters, so the cap errs on the side of not sending.
 */
export const MESSENGER_MAX_TEXT_LENGTH = 1999
const ATTEMPT_TIMEOUT_MS = 15_000

export type SendResult =
  /** Delivered to Meta; `messageId` is the outbound id it answered with (a wamid, or Messenger's mid) */
  | { kind: 'sent'; messageId: string | null; recipientId?: string | null }
  /** Too late for a free-form message (WhatsApp 131047, Messenger 10/2018278). Not retried */
  | { kind: 'outside_window'; status: number }
  /** Meta refused or the request failed, after the one retry */
  | { kind: 'failed'; status: number | null; code: number | null; attempts: number }
  /** The channel has no token, or no business id to send from: nothing was attempted */
  | { kind: 'not_configured'; missing: 'token' | 'phone_number_id' | 'page_id' | 'instagram_account_id' }
  /** Empty, or longer than the platform allows: nothing was attempted */
  | { kind: 'unsendable'; reason: 'empty' | 'too_long' }

type GraphError = { code?: number; error_subcode?: number }

type Platform = {
  /** The log's prefix: [whatsapp/send], [messenger/send] */
  log: string
  /** Whether the text is within the platform's limit (characters, or bytes on Instagram) */
  fits(text: string): boolean
  url(businessId: string): string
  /** What is missing when the channel has no external_id */
  missingId: 'phone_number_id' | 'page_id' | 'instagram_account_id'
  body(to: string, text: string): Record<string, unknown>
  /** The outbound id in an accepted answer */
  messageId(answer: Record<string, unknown>): string | null
  outsideWindow(error: GraphError): boolean
  /** Instagram's private reply: the answer's recipient_id is the commenter's Instagram-scoped id, kept */
  withRecipient?: true
  /** Instagram: the limit is bytes, and a text past NEAR_LIMIT of it is logged even when it fits */
  bytesLimit?: number
}

/**
 * Instagram's limit is bytes, so an Arabic reply that reads short can still
 * be refused. Every Instagram send past 80% of the limit is logged with its
 * byte count, sent or not: the near misses say whether replies need
 * splitting before a refused one says it for us (decided 2026-11-08: one
 * near miss in rig testing and splitting gets built).
 */
const NEAR_LIMIT = 0.8

const WHATSAPP: Platform = {
  log: '[whatsapp/send]',
  fits: (text) => text.length <= MAX_TEXT_LENGTH,
  url: (id) => `${GRAPH}/${id}/messages`,
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
  fits: (text) => text.length <= MESSENGER_MAX_TEXT_LENGTH,
  url: (id) => `${GRAPH}/${id}/messages`,
  missingId: 'page_id',
  body: (to, text) => ({ recipient: { id: to }, messaging_type: 'RESPONSE', message: { text } }),
  messageId: (answer) => (typeof answer.message_id === 'string' ? answer.message_id : null),
  outsideWindow: (error) => isMetaOutsideWindow(error),
}

function isMetaOutsideWindow(error: GraphError) {
  return error.code === MESSENGER_OUTSIDE_WINDOW.code && (MESSENGER_OUTSIDE_WINDOW.subcodes as readonly number[]).includes(error.error_subcode ?? -1)
}

/**
 * Instagram (Unified login): the private reply to a comment. POST
 * {ig-account-id}/messages on graph.facebook.com with the system-user token,
 * recipient {comment_id}. Meta allows one per comment, within 7 days, so the
 * one retry cannot send twice: a second attempt after one that landed is
 * refused. Message text is "a 1000 bytes or less", BYTES: an Arabic letter
 * is two, an emoji four.
 */
// A DEBT TO UNIFY: WhatsApp and Messenger are on v25.0 (GRAPH), Instagram on v26.0. Two versions
// is how a behaviour change arrives for one transport and not the other; move all to one, in a
// change of its own, with a real message on every transport after it.
const INSTAGRAM_GRAPH = 'https://graph.facebook.com/v26.0'
export const INSTAGRAM_MAX_TEXT_BYTES = 1000

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
  if (platform.bytesLimit) {
    const bytes = Buffer.byteLength(text, 'utf8')
    if (bytes > platform.bytesLimit * NEAR_LIMIT) console.warn(`${platform.log} near the byte limit`, { channelId, bytes, limit: platform.bytesLimit, fits: bytes <= platform.bytesLimit })
  }
  if (!platform.fits(text)) return reported(platform, channelId, { kind: 'unsendable', reason: 'too_long' })

  const credentials = await channelCredentials(supabase, channelId)
  if (!credentials.token) return reported(platform, channelId, { kind: 'not_configured', missing: 'token' })
  const { token, businessId } = credentials
  if (!businessId) return reported(platform, channelId, { kind: 'not_configured', missing: platform.missingId })

  const request = {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(platform.body(to, text)),
  }

  let last: { status: number | null; code: number | null } = { status: null, code: null }
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let response: Response
    try {
      response = await fetch(platform.url(businessId), { ...request, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) })
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
      return { kind: 'sent', messageId, ...(platform.withRecipient ? { recipientId: typeof answer.recipient_id === 'string' ? answer.recipient_id : null } : {}) }
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

async function channelCredentials(supabase: SupabaseClient, channelId: string): Promise<{ token: string | null; businessId: string | null }> {
  const { data: secret, error } = await supabase
    .from('channel_secrets')
    .select('access_token, channels(external_id)')
    .eq('channel_id', channelId)
    .maybeSingle<{ access_token: string; channels: { external_id: string | null } | null }>()
  if (error) throw error
  return { token: secret?.access_token || null, businessId: secret?.channels?.external_id || null }
}

const INSTAGRAM_PRIVATE_REPLY: Platform = {
  log: '[instagram/private-reply]',
  fits: (text) => Buffer.byteLength(text, 'utf8') <= INSTAGRAM_MAX_TEXT_BYTES,
  url: (id) => `${INSTAGRAM_GRAPH}/${id}/messages`,
  missingId: 'instagram_account_id',
  body: (commentId, text) => ({ recipient: { comment_id: commentId }, message: { text } }),
  messageId: (answer) => (typeof answer.message_id === 'string' ? answer.message_id : null),
  outsideWindow: (error) => isMetaOutsideWindow(error),
  withRecipient: true,
  bytesLimit: INSTAGRAM_MAX_TEXT_BYTES,
}

/**
 * Instagram (Unified login): a direct message to a person, by their
 * Instagram-scoped id. POST {ig-account-id}/messages on graph.facebook.com,
 * recipient {id}, the same endpoint, token and byte limit as the private
 * reply. Inside the window, like Messenger's RESPONSE; outside it, Meta
 * answers error 10 and it is reported as outside_window, never retried.
 */
const INSTAGRAM_DM: Platform = {
  log: '[instagram/send]',
  fits: (text) => Buffer.byteLength(text, 'utf8') <= INSTAGRAM_MAX_TEXT_BYTES,
  url: (id) => `${INSTAGRAM_GRAPH}/${id}/messages`,
  missingId: 'instagram_account_id',
  body: (to, text) => ({ recipient: { id: to }, message: { text } }),
  messageId: (answer) => (typeof answer.message_id === 'string' ? answer.message_id : null),
  outsideWindow: (error) => isMetaOutsideWindow(error),
  bytesLimit: INSTAGRAM_MAX_TEXT_BYTES,
}

export function sendInstagramText(args: SendArgs): Promise<SendResult> {
  return send(INSTAGRAM_DM, args)
}

/**
 * Facebook: the private reply to a comment on the Page. POST
 * {page-id}/messages with the Page token, recipient {comment_id}, as
 * Messenger's send (v25.0, its character limit). Meta allows one per comment,
 * within 7 days, so the one retry cannot send twice. The answer's
 * recipient_id is the commenter's PSID: their Messenger id (the same person's
 * comment and Messenger message hashed equal on the review clinic's Page,
 * 2026-11-09), kept.
 */
const FACEBOOK_PRIVATE_REPLY: Platform = {
  log: '[facebook/private-reply]',
  fits: (text) => text.length <= MESSENGER_MAX_TEXT_LENGTH,
  url: (id) => `${GRAPH}/${id}/messages`,
  missingId: 'page_id',
  body: (commentId, text) => ({ recipient: { comment_id: commentId }, message: { text } }),
  messageId: (answer) => (typeof answer.message_id === 'string' ? answer.message_id : null),
  outsideWindow: (error) => isMetaOutsideWindow(error),
  withRecipient: true,
}

export function sendFacebookPrivateReply({ supabase, channelId, commentId, body }: { supabase: SupabaseClient; channelId: string; commentId: string; body: string }): Promise<SendResult> {
  return send(FACEBOOK_PRIVATE_REPLY, { supabase, channelId, to: commentId, body })
}

/** The private reply to an Instagram comment; `sent` carries the commenter's Instagram-scoped id (recipientId) */
export function sendInstagramPrivateReply({ supabase, channelId, commentId, body }: { supabase: SupabaseClient; channelId: string; commentId: string; body: string }): Promise<SendResult> {
  return send(INSTAGRAM_PRIVATE_REPLY, { supabase, channelId, to: commentId, body })
}

export type PublicReplyResult =
  | { kind: 'posted'; commentId: string | null }
  | { kind: 'failed'; status: number | null; code: number | null }
  | { kind: 'not_configured'; missing: 'token' }
  | { kind: 'unsendable'; reason: 'empty' | 'too_long' }

/**
 * A PUBLIC reply to a comment, in the clinic's name. ATTEMPTED EXACTLY ONCE:
 * a retry after a timeout that Meta in fact accepted would post the reply
 * twice, in public. A reply that did not go is logged and left; the private
 * reply, which matters more, went first. The answer's id is our reply's
 * comment id, recorded so the reply is known as ours when it comes back.
 *   Instagram  POST /{ig-comment-id}/replies (v26.0), 1000 bytes
 *   Facebook   POST /{comment-id}/comments (v25.0), as the Page:
 *              needs pages_manage_engagement
 */
export function postInstagramCommentReply(args: { supabase: SupabaseClient; channelId: string; commentId: string; body: string }): Promise<PublicReplyResult> {
  return postCommentReply({ log: '[instagram/public-reply]', url: (id) => `${INSTAGRAM_GRAPH}/${id}/replies`, fits: (text) => Buffer.byteLength(text, 'utf8') <= INSTAGRAM_MAX_TEXT_BYTES }, args)
}

export function postFacebookCommentReply(args: { supabase: SupabaseClient; channelId: string; commentId: string; body: string }): Promise<PublicReplyResult> {
  return postCommentReply({ log: '[facebook/public-reply]', url: (id) => `${GRAPH}/${id}/comments`, fits: (text) => text.length <= MESSENGER_MAX_TEXT_LENGTH }, args)
}

async function postCommentReply(
  where: { log: string; url: (commentId: string) => string; fits: (text: string) => boolean },
  { supabase, channelId, commentId, body }: { supabase: SupabaseClient; channelId: string; commentId: string; body: string }
): Promise<PublicReplyResult> {
  const { log } = where
  const text = body.trim()
  if (!text) {
    console.warn(`${log} unsendable`, { channelId, commentId, reason: 'empty' })
    return { kind: 'unsendable', reason: 'empty' }
  }
  if (!where.fits(text)) {
    console.warn(`${log} unsendable`, { channelId, commentId, reason: 'too_long' })
    return { kind: 'unsendable', reason: 'too_long' }
  }
  const { token } = await channelCredentials(supabase, channelId)
  if (!token) {
    console.warn(`${log} not_configured`, { channelId, commentId })
    return { kind: 'not_configured', missing: 'token' }
  }
  let response: Response
  try {
    response = await fetch(where.url(commentId), {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text }),
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    })
  } catch (cause) {
    console.warn(`${log} request failed, not retried`, { channelId, commentId, cause: cause instanceof Error ? cause.name : String(cause) })
    return { kind: 'failed', status: null, code: null }
  }
  const answer = (await response.json().catch(() => ({}))) as { id?: unknown; error?: GraphError }
  if (response.ok) {
    const id = typeof answer.id === 'string' ? answer.id : null
    console.info(`${log} posted`, { channelId, commentId, replyId: id })
    return { kind: 'posted', commentId: id }
  }
  const code = typeof answer.error?.code === 'number' ? answer.error.code : null
  console.warn(`${log} refused, not retried`, { channelId, commentId, status: response.status, code })
  return { kind: 'failed', status: response.status, code }
}

/** A read of one field set from the Graph API with the channel's token: the answer, or null on any failure (logged by status and code) */
async function graphRead(log: string, supabase: SupabaseClient, channelId: string, path: string): Promise<Record<string, unknown> | null> {
  const { token } = await channelCredentials(supabase, channelId)
  if (!token) {
    console.warn(`${log} not_configured`, { channelId })
    return null
  }
  try {
    const response = await fetch(`${GRAPH}/${path}`, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS) })
    const answer = (await response.json().catch(() => ({}))) as Record<string, unknown> & { error?: GraphError }
    if (response.ok) return answer
    console.warn(`${log} refused`, { channelId, status: response.status, code: typeof answer.error?.code === 'number' ? answer.error.code : null })
    return null
  } catch (cause) {
    console.warn(`${log} request failed`, { channelId, cause: cause instanceof Error ? cause.name : String(cause) })
    return null
  }
}

/**
 * Whether a post on the Page is the Page's own: GET /{post-id}?fields=from.
 * A Page's feed carries other people's posts to it, and their post ids start
 * with the Page id too, so only the author decides. 'page' or 'other'; null
 * when it cannot be read (then nothing is answered: unknown is never ours).
 * Needs pages_read_engagement (own posts) and pages_read_user_content
 * (visitor posts).
 */
export async function fetchFacebookPostOwner({ supabase, channelId, pageId, postId }: { supabase: SupabaseClient; channelId: string; pageId: string; postId: string }): Promise<'page' | 'other' | null> {
  const answer = await graphRead('[facebook/post-author]', supabase, channelId, `${encodeURIComponent(postId)}?fields=from`)
  const from = answer && typeof answer.from === 'object' && answer.from !== null ? (answer.from as { id?: unknown }) : null
  const id = typeof from?.id === 'string' ? from.id : typeof from?.id === 'number' ? String(from.id) : null
  if (!id) return null
  return id === pageId ? 'page' : 'other'
}

/**
 * Whether a comment is hidden: GET /{comment-id}?fields=is_hidden. A
 * clinic's moderation (its own hiding, or the Page's word and profanity
 * filters, which hide on arrival) is never overridden: a hidden comment gets
 * no private message and no public reply. Null when it cannot be read (then
 * nothing is sent either).
 */
export async function fetchFacebookCommentHidden({ supabase, channelId, commentId }: { supabase: SupabaseClient; channelId: string; commentId: string }): Promise<boolean | null> {
  const answer = await graphRead('[facebook/comment-hidden]', supabase, channelId, `${encodeURIComponent(commentId)}?fields=is_hidden`)
  return answer && typeof answer.is_hidden === 'boolean' ? answer.is_hidden : null
}

/**
 * The Instagram username of a person who wrote to the account, by their
 * Instagram-scoped id: GET /{igsid}?fields=username with the channel's
 * token. For naming the conversation when no comment of theirs gave it.
 * Meta answers this only for someone who has messaged the account, and
 * before Advanced Access only for people with a role on the app. Null on
 * any failure, logged by status and code; never retried, never the username
 * in the log.
 */
export async function fetchInstagramUsername({ supabase, channelId, igsid }: { supabase: SupabaseClient; channelId: string; igsid: string }): Promise<string | null> {
  const log = '[instagram/profile]'
  const { token } = await channelCredentials(supabase, channelId)
  if (!token) {
    console.warn(`${log} not_configured`, { channelId })
    return null
  }
  try {
    const response = await fetch(`${INSTAGRAM_GRAPH}/${encodeURIComponent(igsid)}?fields=username`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(ATTEMPT_TIMEOUT_MS),
    })
    const answer = (await response.json().catch(() => ({}))) as { username?: unknown; error?: GraphError }
    if (response.ok && typeof answer.username === 'string' && answer.username.trim()) return answer.username.trim()
    console.warn(`${log} no username`, { channelId, status: response.status, code: typeof answer.error?.code === 'number' ? answer.error.code : null })
    return null
  } catch (cause) {
    console.warn(`${log} request failed`, { channelId, cause: cause instanceof Error ? cause.name : String(cause) })
    return null
  }
}

/** Every outcome that is not a send is written to the log by kind, with nothing of the message in it */
function reported<T extends Exclude<SendResult, { kind: 'sent' }>>(platform: Platform, channelId: string, result: T): T {
  console.warn(`${platform.log} ${result.kind}`, { channelId, ...result })
  return result
}
