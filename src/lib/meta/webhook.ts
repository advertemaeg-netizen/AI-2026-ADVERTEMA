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
}

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
export function deliveryShape(payload: unknown): DeliveryShape {
  const body = isObject(payload) ? payload : {}
  const object = text(body.object) ?? 'unknown'
  const channel = CHANNELS[object] ?? 'unknown'

  const entries = list(body.entry).map((entry): EntryShape => {
    const entryId = text(entry.id)
    const time = typeof entry.time === 'number' ? entry.time : undefined
    if (channel === 'whatsapp') return { entryId, time, ...whatsappEntry(entry) }
    return { entryId, businessId: entryId, time, events: list(entry.messaging).map(messagingEvent) }
  })
  return { object, channel, entries }
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

function messagingEvent(event: Json): EventShape {
  const kind = MESSAGING_KINDS.find((key) => key in event) ?? 'unknown'
  const timestamp = stamp(event.timestamp)
  if (kind !== 'message' || !isObject(event.message)) return { kind, timestamp }

  const message = event.message
  const attachment = list(message.attachments)[0]
  const messageType = attachment ? text(attachment.type) : 'text' in message ? 'text' : undefined
  return { kind, messageId: text(message.mid), messageType, timestamp, ...(message.is_echo === true ? { echo: true } : {}) }
}
