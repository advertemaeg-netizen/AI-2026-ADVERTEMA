import type { ChannelType } from './channels'

export const CONVERSATION_STATUSES = ['new', 'in_progress', 'converted', 'closed'] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

/**
 * Why a conversation waits for a person (conversations.needs_human_reason).
 * Each one asks something different of the client:
 * service_down — the AI call failed, ours to fix; limit_reached — upgrade the
 * plan; inactive — pay; no_answer — the knowledge base lacks the answer.
 */
export const NEEDS_HUMAN_REASONS = ['service_down', 'limit_reached', 'inactive', 'no_answer', 'send_failed'] as const
export type NeedsHumanReason = (typeof NEEDS_HUMAN_REASONS)[number]
/** The reason shown for a marked conversation whose needs_human_reason is null */
export const DEFAULT_NEEDS_HUMAN_REASON: NeedsHumanReason = 'service_down'

export const DATE_RANGES = ['today', '7d', '30d'] as const
export type DateRange = (typeof DATE_RANGES)[number]

export type MessageRole = 'user' | 'assistant' | 'agent' | 'system'

export type ConversationFilters = {
  clientId?: string
  status?: ConversationStatus
  channelType?: ChannelType
  range?: DateRange
  q?: string
}

export type ConversationListItem = {
  id: string
  status: ConversationStatus
  contact_name: string | null
  contact_identifier: string | null
  last_message_at: string
  last_message_preview: string | null
  last_message_role: MessageRole | null
  assigned_to: string | null
  /** Since when a visitor message has had no real answer (the AI call failed); null once a person replies */
  needs_human_since: string | null
  needs_human_reason: NeedsHumanReason | null
  client: { id: string; name: string }
  channel: { id: string; type: ChannelType; name: string }
}

/**
 * Why an outbound message did not reach the person (metadata.send.reason).
 * Each is something the employee can act on, and each has its own line:
 *   outside_window  more than 24 hours since the person last wrote
 *   paused          the channel, client or organization is off: nothing was attempted
 *   disconnected    the channel has no token or account id, or Meta says its token is no good
 *   too_long        longer than this channel allows
 *   refused         Meta refused it, or the request failed, after the one retry
 * A message still 'sending' after STUCK_AFTER_MS is shown as stuck: the
 * send never finished (a restart mid-send). That one is read, not stored.
 */
export const SEND_FAILURES = ['outside_window', 'paused', 'disconnected', 'too_long', 'refused'] as const
export type SendFailure = (typeof SEND_FAILURES)[number]

/** The failures "send again" is offered on: something might have changed. The others need a condition to change first */
export const RETRYABLE_FAILURES: readonly (SendFailure | 'stuck')[] = ['refused', 'stuck']

export const STUCK_AFTER_MS = 2 * 60_000

/** An outbound row's send, as metadata.send records it */
export type MessageSend = {
  transport?: string
  state: 'sending' | 'sent' | 'failed'
  messageId?: string | null
  reason?: SendFailure
  /** When a "send again" began: a retried row's age is counted from here, not from when it was written */
  at?: string
}

/** Whether a row has been 'sending' too long to be a send still in flight */
export function isStuck(message: Pick<Message, 'send' | 'created_at'>, now = Date.now()) {
  return message.send?.state === 'sending' && now - new Date(message.send.at ?? message.created_at).getTime() > STUCK_AFTER_MS
}

export type Message = {
  id: string
  conversation_id: string
  role: MessageRole
  content: string
  sender_id: string | null
  created_at: string
  /** metadata.send: set on every outbound row of a Meta conversation, absent on the website's */
  send?: MessageSend | null
  /** metadata.delivery: a bot reply the person never received (its failure kind) */
  delivery?: { failed?: string } | null
}

/**
 * Why the reply box is closed, before anyone types:
 *   paused           the channel, client or organization is off
 *   disconnected     the channel has no token or account id
 *   outside_window   more than 24 hours since the person last wrote
 *   comment_thread   a public Instagram comment thread: a reply typed here
 *                    would land in the person's private messages
 */
export const REPLY_BLOCKS = ['paused', 'disconnected', 'outside_window', 'comment_thread'] as const
export type ReplyBlock = (typeof REPLY_BLOCKS)[number]

/** The 24-hour window Meta allows a free-form reply in, after the person's last message */
export const REPLY_WINDOW_MS = 24 * 60 * 60_000

/**
 * The longest reply each channel takes, as the reply box counts it. The
 * website and WhatsApp take the dashboard's own cap (WhatsApp allows 4096);
 * Messenger 1999 characters; Instagram 1000 BYTES, so an Arabic letter
 * counts two. Kept equal to src/lib/meta/send.ts by tests/meta/agent-reply.test.ts.
 */
export const REPLY_LIMITS: Record<ChannelType, { chars: number } | { bytes: number }> = {
  website: { chars: 4000 },
  whatsapp: { chars: 4000 },
  facebook: { chars: 1999 },
  instagram: { bytes: 1000 },
}

/** Whether a reply fits its channel, counted the way the channel counts */
export function fitsChannel(type: ChannelType, text: string) {
  const limit = REPLY_LIMITS[type]
  return 'bytes' in limit ? new TextEncoder().encode(text).length <= limit.bytes : text.length <= limit.chars
}

/** What the reply box needs to know: whether it is closed and why, and when the window closes */
export type ReplyAvailability = {
  blocked: ReplyBlock | null
  /** When the 24-hour window closes, for a Meta conversation the person has written in; null when there is no window to keep */
  windowEndsAt: string | null
}

export type TeamMember = {
  id: string
  full_name: string | null
  email: string
  role: string
}

export type ConversationDetail = ConversationListItem & {
  created_at: string
  auto_reply_enabled: boolean
  /** 'dm', or an Instagram comment thread ('comments') */
  thread: 'dm' | 'comments'
  client: { id: string; name: string; industry: string | null; status: string }
}

export type ConversationActionError =
  | 'impersonating'
  | 'unauthorized'
  | 'forbidden'
  | 'validation'
  | 'notFound'
  | 'unknown'

export type ConversationActionResult<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true; data: T })
  | { ok: false; error: ConversationActionError }
