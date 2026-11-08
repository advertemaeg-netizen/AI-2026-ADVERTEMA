import 'server-only'
import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Meta's webhook (WhatsApp Cloud API, Messenger, Instagram): receive and log.
 *
 * What is logged is the shape of a delivery, never its content: no message
 * text, no sender (a WhatsApp sender is a phone number, a Messenger one a
 * page-scoped id that identifies the person), no contact names. Only Meta's
 * own ids, the business's ids (the WhatsApp phone_number_id, the page id) and
 * types and timestamps. Anything added here must keep to that.
 *
 * ONE EXCEPTION, FOR A TEST WINDOW ONLY: while META_TEST_ID_HASH_SECRET is
 * set, the person ids on a Messenger or Instagram delivery (a sender, a
 * recipient, a commenter's from.id) are logged as a 12-hex keyed hash of the
 * id, never the id. Two hashes are equal exactly when the ids are, which is
 * all the receive-only test needs (is a commenter's id the id their DM
 * carries?). The secret exists for that test alone, is not the app secret,
 * and is thrown away after it, so the hashes cannot be matched again. Unset,
 * no person field is logged at all. An id equal to the entry's own (the Page
 * or the Instagram account, a business id) is logged as 'business'.
 */

const SIGNATURE = /^sha256=([0-9a-f]{64})$/

/** The header's form alone, so an unsigned or malformed request is refused before its body is read */
export function signatureDigest(header: string | null): Buffer | null {
  const match = header?.trim().toLowerCase().match(SIGNATURE)
  return match ? Buffer.from(match[1], 'hex') : null
}

/** X-Hub-Signature-256: an HMAC-SHA256 of the raw body, keyed with the app secret */
export function signatureMatches(rawBody: Buffer, digest: Buffer, appSecret: string) {
  const expected = createHmac('sha256', appSecret).update(rawBody).digest()
  return expected.length === digest.length && timingSafeEqual(expected, digest)
}

export type MetaChannel = 'whatsapp' | 'messenger' | 'instagram' | 'unknown'

/** One event in a delivery, as logged */
export type EventShape = {
  /** message, status (WhatsApp), or Messenger's event key: postback, read, delivery, reaction… */
  kind: string
  /** The WhatsApp change's field ('messages', 'account_update'…); absent for Messenger */
  field?: string
  /** wamid… or Messenger's mid */
  messageId?: string
  /** text, image, audio, interactive… */
  messageType?: string
  /** WhatsApp status: sent, delivered, read, failed */
  status?: string
  /** A WhatsApp status's error codes, never their text (which can quote the message) */
  errorCodes?: number[]
  /** Messenger: the business's own message, echoed back */
  echo?: true
  /** As Meta sent it: seconds (WhatsApp) or milliseconds (Messenger) */
  timestamp?: string | number
  /** Messenger/Instagram message: whether it carries text (a story mention may or may not); never the text */
  hasText?: boolean
  /** Instagram: a reply to the business's story */
  storyReply?: true
  /** Instagram: the person deleted the message */
  deleted?: true
  /** Messenger/Instagram: who sent and who received, as a Party (see idParty) */
  sender?: Party
  recipient?: Party
  /** A Page feed or Instagram comment change: Meta's own values, never the content */
  item?: string
  verb?: string
  commentId?: string
  postId?: string
  parentId?: string
  mediaId?: string
  mediaProductType?: string
  /** The change's author as a Party, the names of the keys its from carries (never their values), and the id's length */
  from?: Party
  fromKeys?: string[]
  fromIdLength?: number
  /** The names of the keys the change's value carries, never their values: the delivery's shape */
  valueKeys?: string[]
}

/** 'business' for the entry's own id (the Page or the Instagram account), otherwise a 12-hex keyed hash of the id */
export type Party = string

export type EntryShape = {
  /** WhatsApp: the business account (WABA) id; Messenger/Instagram: the page or account id */
  entryId?: string
  /** The id a channel would be found by: WhatsApp's phone_number_id, otherwise the entry id */
  businessId?: string
  time?: number
  events: EventShape[]
}

export type DeliveryShape = { object: string; channel: MetaChannel; entries: EntryShape[] }

const CHANNELS: Record<string, MetaChannel> = {
  whatsapp_business_account: 'whatsapp',
  page: 'messenger',
  instagram: 'instagram',
}

// The channels table's type for each, where the business's id is external_id
export const CHANNEL_TYPE: Record<MetaChannel, string | null> = {
  whatsapp: 'whatsapp',
  messenger: 'facebook',
  instagram: 'instagram',
  unknown: null,
}

// Messenger's event keys besides the sender, recipient and timestamp
const MESSAGING_KINDS = ['message', 'postback', 'read', 'delivery', 'reaction', 'referral', 'optin', 'account_linking']

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : [])
const text = (value: unknown) => (typeof value === 'string' ? value : undefined)
const stamp = (value: unknown) => (typeof value === 'string' || typeof value === 'number' ? value : undefined)

/**
 * The delivery reduced to what may be logged. Every field is picked by name,
 * so anything Meta adds later stays out of the log until it is chosen here.
 */
export function deliveryShape(payload: unknown, options: { idHashSecret?: string } = {}): DeliveryShape {
  const body = isObject(payload) ? payload : {}
  const object = text(body.object) ?? 'unknown'
  const channel = CHANNELS[object] ?? 'unknown'

  const entries = list(body.entry).map((entry): EntryShape => {
    const entryId = text(entry.id)
    const time = typeof entry.time === 'number' ? entry.time : undefined
    if (channel === 'whatsapp') return { entryId, time, ...whatsappEntry(entry) }
    const party = idParty(entryId, options.idHashSecret)
    return {
      entryId,
      businessId: entryId,
      time,
      events: [...list(entry.messaging).map((event) => messagingEvent(event, party)), ...entryChanges(entry).map((change) => changeEvent(change, party))],
    }
  })
  return { object, channel, entries }
}

/**
 * How a person id is logged: 'business' when it is the entry's own, the
 * keyed hash while the test secret is set, otherwise not at all.
 */
function idParty(entryId: string | undefined, secret: string | undefined) {
  return (id: unknown): Party | undefined => {
    const value = typeof id === 'string' ? id : typeof id === 'number' ? String(id) : undefined
    if (value === undefined) return undefined
    if (value === entryId) return 'business'
    if (!secret) return undefined
    return createHmac('sha256', secret).update(value).digest('hex').slice(0, 12)
  }
}

/**
 * A Page or Instagram entry's changes. Instagram's documented shape for
 * Business Login puts one change's field and value on the entry itself, not
 * in changes[]; both are read, so whichever arrives is seen.
 */
function entryChanges(entry: Json): Json[] {
  const changes = list(entry.changes)
  if (typeof entry.field === 'string') changes.push({ field: entry.field, value: entry.value })
  return changes
}

function changeEvent(change: Json, party: (id: unknown) => Party | undefined): EventShape {
  const field = text(change.field)
  const value = isObject(change.value) ? change.value : {}
  const from = isObject(value.from) ? value.from : undefined
  const media = isObject(value.media) ? value.media : {}
  // Instagram names a comment's id comment_id on one login path and id on the other
  const commentId = text(value.comment_id) ?? (field === 'comments' || field === 'live_comments' ? text(value.id) : undefined)
  const fromId = from ? (typeof from.id === 'string' || typeof from.id === 'number' ? String(from.id) : undefined) : undefined
  const sender = from ? party(from.id) : undefined
  const shape: EventShape = {
    kind: 'change',
    field,
    item: text(value.item),
    verb: text(value.verb),
    commentId,
    postId: text(value.post_id),
    parentId: text(value.parent_id),
    mediaId: text(media.id) ?? text(value.media_id),
    mediaProductType: text(media.media_product_type),
    hasText: typeof value.message === 'string' ? value.message.length > 0 : typeof value.text === 'string' ? value.text.length > 0 : undefined,
    ...(sender ? { from: sender } : {}),
    ...(from ? { fromKeys: Object.keys(from).sort() } : {}),
    ...(fromId !== undefined ? { fromIdLength: fromId.length } : {}),
    valueKeys: Object.keys(value).sort(),
  }
  return Object.fromEntries(Object.entries(shape).filter(([, v]) => v !== undefined)) as EventShape
}

function whatsappEntry(entry: Json): { businessId?: string; events: EventShape[] } {
  let businessId: string | undefined
  const events: EventShape[] = []
  for (const change of list(entry.changes)) {
    const field = text(change.field)
    const value = isObject(change.value) ? change.value : {}
    const metadata = isObject(value.metadata) ? value.metadata : {}
    businessId ??= text(metadata.phone_number_id)

    const messages = list(value.messages)
    const statuses = list(value.statuses)
    for (const message of messages) {
      events.push({ kind: 'message', field, messageId: text(message.id), messageType: text(message.type), timestamp: stamp(message.timestamp) })
    }
    for (const status of statuses) {
      const errorCodes = list(status.errors).flatMap((error) => (typeof error.code === 'number' ? [error.code] : []))
      events.push({
        kind: 'status',
        field,
        messageId: text(status.id),
        status: text(status.status),
        timestamp: stamp(status.timestamp),
        ...(errorCodes.length ? { errorCodes } : {}),
      })
    }
    // A change that is neither (account_update, templates…): its field is enough
    if (messages.length === 0 && statuses.length === 0) events.push({ kind: 'change', field })
  }
  return { businessId, events }
}

function messagingEvent(event: Json, party: (id: unknown) => Party | undefined): EventShape {
  const kind = MESSAGING_KINDS.find((key) => key in event) ?? 'unknown'
  const timestamp = stamp(event.timestamp)
  if (kind !== 'message' || !isObject(event.message)) return { kind, timestamp }

  const message = event.message
  const attachment = list(message.attachments)[0]
  const messageType = attachment ? text(attachment.type) : 'text' in message ? 'text' : undefined
  const replyTo = isObject(message.reply_to) ? message.reply_to : {}
  const sender = party(isObject(event.sender) ? event.sender.id : undefined)
  const recipient = party(isObject(event.recipient) ? event.recipient.id : undefined)
  return {
    kind,
    messageId: text(message.mid),
    messageType,
    timestamp,
    hasText: typeof message.text === 'string' && message.text.length > 0,
    ...(message.is_echo === true ? { echo: true } : {}),
    ...(isObject(replyTo.story) ? { storyReply: true } : {}),
    ...(message.is_deleted === true ? { deleted: true } : {}),
    ...(sender ? { sender } : {}),
    ...(recipient ? { recipient } : {}),
  }
}

/**
 * AN INBOUND WHATSAPP MESSAGE, WITH ITS CONTENT. For processing only: the
 * sender's number and the text are what the pipeline needs and exactly what
 * the log must never carry (deliveryShape is the log's view). Anything that
 * reads this must keep to the same rule.
 */
export type InboundWhatsAppMessage = {
  /** The WhatsApp phone_number_id the message arrived on: the channel's external_id */
  businessId: string
  /** The wamid, exactly as Meta sent it */
  messageId: string
  /** The sender's number as Meta gives it: digits, no "+" (e.g. "2010…") */
  from: string
  /** text, image, audio, interactive… */
  type: string
  /** The text body, for a text message */
  text?: string
  /** For a reaction: the emoji ("" when one is taken back) and the wamid it was put on */
  reaction?: { emoji: string; messageId?: string }
  /** The sender's WhatsApp profile name, when the delivery carries it */
  profileName?: string
  timestamp?: string
}

export function inboundWhatsAppMessages(payload: unknown): InboundWhatsAppMessage[] {
  const body = isObject(payload) ? payload : {}
  if (text(body.object) !== 'whatsapp_business_account') return []
  const out: InboundWhatsAppMessage[] = []
  for (const entry of list(body.entry)) {
    for (const change of list(entry.changes)) {
      const value = isObject(change.value) ? change.value : {}
      const metadata = isObject(value.metadata) ? value.metadata : {}
      const businessId = text(metadata.phone_number_id)
      if (!businessId) continue
      const names = new Map(list(value.contacts).map((c) => [text(c.wa_id), text(isObject(c.profile) ? c.profile.name : undefined)]))
      for (const message of list(value.messages)) {
        const messageId = text(message.id)
        const from = text(message.from)
        const type = text(message.type)
        if (!messageId || !from || !type) continue
        const textBody = isObject(message.text) ? text(message.text.body) : undefined
        const reaction = isObject(message.reaction) ? message.reaction : undefined
        out.push({
          businessId,
          messageId,
          from,
          type,
          ...(textBody !== undefined ? { text: textBody } : {}),
          ...(reaction ? { reaction: { emoji: text(reaction.emoji) ?? '', ...(text(reaction.message_id) ? { messageId: text(reaction.message_id) } : {}) } } : {}),
          ...(names.get(from) ? { profileName: names.get(from) } : {}),
          ...(text(message.timestamp) !== undefined ? { timestamp: text(message.timestamp) } : {}),
        })
      }
    }
  }
  return out
}

/**
 * A WHATSAPP STATUS: what became of a message we sent (sent, delivered, read,
 * failed), keyed by the wamid our send recorded. For processing only: the
 * recipient's number is how the row's conversation is found, and the log
 * never carries it (deliveryShape logs the status and its codes).
 */
export type InboundWhatsAppStatus = {
  /** The WhatsApp phone_number_id the message went from: the channel's external_id */
  businessId: string
  /** The outbound wamid */
  messageId: string
  status: string
  /** The recipient's number as Meta gives it (the conversation's contact_identifier) */
  recipientId?: string
  /** The status's error codes, never their text */
  errorCodes: number[]
}

export function inboundWhatsAppStatuses(payload: unknown): InboundWhatsAppStatus[] {
  const body = isObject(payload) ? payload : {}
  if (text(body.object) !== 'whatsapp_business_account') return []
  const out: InboundWhatsAppStatus[] = []
  for (const entry of list(body.entry)) {
    for (const change of list(entry.changes)) {
      const value = isObject(change.value) ? change.value : {}
      const metadata = isObject(value.metadata) ? value.metadata : {}
      const businessId = text(metadata.phone_number_id)
      if (!businessId) continue
      for (const status of list(value.statuses)) {
        const messageId = text(status.id)
        const state = text(status.status)
        if (!messageId || !state) continue
        const recipientId = idOf(status.recipient_id)
        out.push({
          businessId,
          messageId,
          status: state,
          ...(recipientId ? { recipientId } : {}),
          errorCodes: list(status.errors).flatMap((error) => (typeof error.code === 'number' ? [error.code] : [])),
        })
      }
    }
  }
  return out
}

/**
 * A MESSENGER EVENT, WITH ITS CONTENT. For processing only, under the same
 * rule as InboundWhatsAppMessage: the PSID and the text are what the
 * pipeline needs and exactly what the log must never carry.
 *
 *   message   a person wrote to the Page: answered through the pipeline
 *   echo      the Page sent a message: ours (a reply we sent) or a person at
 *             the clinic answering from the Page inbox. Which, is decided by
 *             the ids we sent (inbound.ts), never by a field of the echo
 *   reaction  a person reacted to a message: stored, never answered
 *
 * `claimId` is what processed_meta_messages records, so a retry does
 * nothing: the mid for a message or an echo. A reaction has no id of its
 * own (its mid is the message reacted to), so it is claimed by that mid, the
 * action, the emoji and the event's timestamp, all Meta's values, which a
 * retry repeats. No person id goes into a claim.
 *
 * Read receipts, deliveries, postbacks (we send no buttons), referrals and
 * optins are not events here: they carry nothing to answer.
 */
export type InboundMessengerEvent =
  | {
      kind: 'message'
      /** The Page the message arrived on: the channel's external_id */
      pageId: string
      claimId: string
      messageId: string
      /** The sender's page-scoped id (PSID) */
      from: string
      /** text, or the first attachment's type: image, audio, video, file, sticker, fallback… */
      type: string
      text?: string
    }
  | {
      kind: 'echo'
      pageId: string
      claimId: string
      messageId: string
      /** The PSID the Page's message went to */
      to: string
      type: string
      text?: string
    }
  | {
      kind: 'reaction'
      pageId: string
      claimId: string
      from: string
      /** The emoji ('' when Meta sends none), react or unreact, and the mid it was put on */
      reaction: { emoji: string; action: string; messageId: string }
    }

export function inboundMessengerEvents(payload: unknown): InboundMessengerEvent[] {
  return messagingEvents(payload, 'page')
}

/**
 * AN INSTAGRAM DIRECT MESSAGE, WITH ITS CONTENT: the same shape as
 * Messenger's (entry.messaging, mid, is_echo, attachments), keyed by the
 * Instagram account instead of the Page (`pageId` here is the account id,
 * the channel's external_id) and by the person's Instagram-scoped id. Echoes
 * arrive on the `messages` field (seen on the review clinic, 2026-11-08,
 * sender the account itself, recipient the person). A story mention is a
 * message whose attachment type is story_mention.
 */
export function inboundInstagramEvents(payload: unknown): InboundMessengerEvent[] {
  return messagingEvents(payload, 'instagram')
}

function messagingEvents(payload: unknown, object: 'page' | 'instagram'): InboundMessengerEvent[] {
  const body = isObject(payload) ? payload : {}
  if (text(body.object) !== object) return []
  const out: InboundMessengerEvent[] = []
  for (const entry of list(body.entry)) {
    const pageId = text(entry.id)
    if (!pageId) continue
    for (const event of list(entry.messaging)) {
      const sender = isObject(event.sender) ? idOf(event.sender.id) : undefined
      const recipient = isObject(event.recipient) ? idOf(event.recipient.id) : undefined
      if (isObject(event.message)) {
        const message = event.message
        const messageId = text(message.mid)
        if (!messageId || message.is_deleted === true) continue
        const type = messengerType(message)
        const textBody = typeof message.text === 'string' ? message.text : undefined
        if (message.is_echo === true) {
          if (!recipient || recipient === pageId) continue
          out.push({ kind: 'echo', pageId, claimId: messageId, messageId, to: recipient, type, ...(textBody !== undefined ? { text: textBody } : {}) })
        } else {
          // A message from the Page itself without the echo flag is not a person writing to it
          if (!sender || sender === pageId) continue
          out.push({ kind: 'message', pageId, claimId: messageId, messageId, from: sender, type, ...(textBody !== undefined ? { text: textBody } : {}) })
        }
        continue
      }
      if (isObject(event.reaction)) {
        const reaction = event.reaction
        const messageId = text(reaction.mid)
        if (!messageId || !sender || sender === pageId) continue
        const action = text(reaction.action) ?? 'react'
        const emoji = text(reaction.emoji) ?? ''
        const timestamp = stamp(event.timestamp) ?? ''
        out.push({ kind: 'reaction', pageId, claimId: `reaction:${messageId}:${action}:${emoji}:${timestamp}`, from: sender, reaction: { emoji, action, messageId } })
      }
    }
  }
  return out
}

const idOf = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined)

/** A Messenger message's type: its first attachment's (a sticker is an image carrying a sticker_id), or text */
function messengerType(message: Json): string {
  const attachment = list(message.attachments)[0]
  if (!attachment) return 'text'
  const payload = isObject(attachment.payload) ? attachment.payload : {}
  if ('sticker_id' in payload) return 'sticker'
  return text(attachment.type) ?? 'unsupported'
}

/**
 * AN INSTAGRAM COMMENT, WITH ITS CONTENT. For processing only, under the same
 * rule as the other inbound types: the commenter's id, username and text are
 * what the reply path needs and what the log must never carry.
 *
 * Only the `comments` field. `mentions` (comments on OTHER people's media
 * that tag the account) and `live_comments` are never comments here: a
 * clinic does not reply under a stranger's post, on any switch.
 *
 * The comment's id is `comment_id` in Meta's Unified-login example and `id`
 * in what Instagram actually delivered to us (2026-11-04): both are read.
 */
export type InboundInstagramComment = {
  /** The Instagram account the comment is on: the channel's external_id */
  accountId: string
  commentId: string
  /** Set when the comment answers another comment */
  parentId?: string
  mediaId?: string
  mediaProductType?: string
  /** Present on an ad's comments */
  adId?: string
  /** The commenter's Instagram-scoped id, and username (public, as it shows under the post) */
  from: { id: string; username?: string }
  text?: string
}

export function inboundInstagramComments(payload: unknown): InboundInstagramComment[] {
  const body = isObject(payload) ? payload : {}
  if (text(body.object) !== 'instagram') return []
  const out: InboundInstagramComment[] = []
  for (const entry of list(body.entry)) {
    const accountId = text(entry.id)
    if (!accountId) continue
    for (const change of entryChanges(entry)) {
      if (text(change.field) !== 'comments') continue
      const value = isObject(change.value) ? change.value : {}
      const from = isObject(value.from) ? value.from : {}
      const fromId = idOf(from.id)
      const commentId = text(value.comment_id) ?? text(value.id)
      if (!commentId || !fromId) continue
      const media = isObject(value.media) ? value.media : {}
      const parentId = text(value.parent_id)
      const mediaId = text(media.id) ?? text(value.media_id)
      const mediaProductType = text(media.media_product_type)
      const adId = text(media.ad_id)
      const username = text(from.username)
      const commentText = text(value.text)
      out.push({
        accountId,
        commentId,
        ...(parentId ? { parentId } : {}),
        ...(mediaId ? { mediaId } : {}),
        ...(mediaProductType ? { mediaProductType } : {}),
        ...(adId ? { adId } : {}),
        from: { id: fromId, ...(username ? { username } : {}) },
        ...(commentText !== undefined ? { text: commentText } : {}),
      })
    }
  }
  return out
}
