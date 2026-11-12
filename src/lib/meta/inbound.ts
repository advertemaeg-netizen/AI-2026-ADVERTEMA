import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { ContactState } from '@/lib/ai/contact'
import { conversationStore, replyToMessage, type ReplyOutcome, type ReplyStore } from '@/lib/ai/reply'
import { recordResult, type RowMetadata } from '@/lib/meta/delivery'
import { fetchInstagramUsername, sendInstagramText, sendMessengerText, sendWhatsAppText, type SendResult } from '@/lib/meta/send'
import type { InboundMessengerEvent, InboundWhatsAppMessage } from '@/lib/meta/webhook'
import {
  WHATSAPP_HANDOFF_AR,
  WHATSAPP_PLACEHOLDER_AR,
  WHATSAPP_UNAVAILABLE_AR,
  WHATSAPP_UNSUPPORTED_AR,
} from '@/lib/meta/whatsapp-notices-ar'
import { normalizePhone } from '@/lib/phone'
import { errorForLog } from '@/lib/log'

/**
 * WHATSAPP AND MESSENGER ARE TRANSPORTS FOR THE PIPELINE WE HAVE
 * (.scratch/whatsapp-send-design.md §0, §5; .scratch/messenger-instagram-design.md
 * §0). An inbound text message is given the same treatment a widget message
 * gets: the conversation is found or opened for the sender, the message is
 * stored, replyToMessage() does everything the website does, and the outcome
 * goes back out through the transport's send. Nothing here holds a
 * conversation, writes a lead or decides a booking: that is the pipeline's,
 * and it is one function for every transport. The two transports share every
 * rule below; what differs is the send, what the sender's id is (a number on
 * WhatsApp, a PSID on Messenger), and what is known before the first word.
 *
 * What differs from the website is what the transport knows and what it can
 * show. On WhatsApp the sender's number arrives with the delivery, so it
 * enters the pipeline as the known contact: told to the model as on record,
 * written onto the lead when one opens, never asked for. Messenger carries no
 * number, so nothing is known. And there is no widget to show a notice, so
 * where the website delivers no text the clinic speaks:
 *
 *   - handoff: a person has the conversation. The notice goes out only while
 *     no person has spoken since: once a human agent's message exists, the
 *     customer knows a person is there and the notice has nothing left to
 *     say. Never twice (a customer who writes three times while waiting
 *     must not be told three times).
 *   - unavailable: the service could not answer. Never sent back-to-back:
 *     not if the last outbound message is already this notice. A broken
 *     system that says so once is honest; three times looks broken twice.
 *
 * The notices and placeholders are the WhatsApp strings on both transports
 * (none of them names WhatsApp): one copy, so a fix cannot land in one and
 * not the other.
 *
 * A message that is not text (a voice note, above all: a large share of
 * people message a business that way) is stored as a placeholder saying
 * what arrived, so the conversation shows it and an agent can tell. It gets
 * one reply in the bot's voice saying text only, once per run (not for a
 * second voice note in a row), and none while a person has the
 * conversation: they can listen. A reaction is stored the same way and
 * never answered: it never enters the pipeline, so nothing can take a
 * thumbs-up for a confirmation.
 *
 * Every notice is written to the conversation as a message, because it
 * reached a customer's phone: an agent opening the conversation sees what the
 * customer was told. The unavailable text is ours, not the client's
 * settings, because settings failing to load is one of the ways here. And a
 * reply that was stored but not sent is marked on its row (metadata.delivery):
 * an answer the customer never received must not read in the dashboard as one
 * they did.
 *
 * EVERY OUTBOUND ROW RECORDS ITS SEND (metadata.send): 'sending' is written
 * with the row, before the send is attempted; 'sent' with the outbound
 * message id once Meta answers; 'failed' if it did not go. On Messenger this
 * is what tells our replies from a person's: Meta echoes every message the
 * Page sends, ours and those a person at the clinic types in the Page inbox,
 * and the echo can arrive before the send's own answer. See handleEcho.
 *
 * NEVER LOGGED: the text, the sender's number or PSID, the profile name.
 * Logged: the channel id, the conversation id, the message id, the outcome
 * and send kinds.
 */

const SOURCE = 'webhook/meta'

export type InboundChannel = {
  id: string
  client_id: string
  is_active: boolean
  /** Comment replies in the clinic's name: off unless switched on for this channel (20261119100000) */
  comment_replies_enabled?: boolean
  clients: {
    name: string
    industry: string | null
    description: string | null
    status: string
    organizations: { is_active: boolean } | null
  } | null
}

/** A disabled channel, client or organization: the message is not stored and nothing is answered, as on the website (403) */
export function isLive(channel: InboundChannel) {
  return channel.is_active && channel.clients?.status === 'active' && channel.clients.organizations?.is_active === true
}

/** What went out: a send's result, nothing (no text to send, or the notice had been told), or the notice already said */
type Sent = SendResult['kind'] | 'none' | 'already_told'

export type InboundDisposition =
  | { kind: 'inactive' }
  /** A reaction: stored so an agent sees it, never answered */
  | { kind: 'reaction'; conversationId: string }
  | { kind: 'not_text'; type: string; conversationId: string; send: Sent }
  | { kind: 'answered'; conversationId: string; outcome: ReplyOutcome['kind']; send: Sent }
  /** Messenger or Instagram: the echo of a message we sent */
  | { kind: 'echo_ours'; conversationId: string }
  /** Messenger or Instagram: a person at the clinic answered from the Page inbox or the Instagram app; stored as theirs, and the bot stands down */
  | { kind: 'echo_agent'; conversationId: string }
  /** Instagram: a story mention, out of this build (.scratch/agent-reply-decisions.md §3.5): claimed, not stored, not answered */
  | { kind: 'story_mention' }

type Transport = {
  name: 'whatsapp' | 'messenger' | 'instagram'
  send(args: { supabase: SupabaseClient; channelId: string; to: string; body: string }): Promise<SendResult>
}

const WHATSAPP: Transport = { name: 'whatsapp', send: sendWhatsAppText }
const MESSENGER: Transport = { name: 'messenger', send: sendMessengerText }
const INSTAGRAM: Transport = { name: 'instagram', send: sendInstagramText }

/** What a transport hands the shared handler: the sender, what arrived, and what is known of them */
type Inbound = {
  messageId: string
  /** The sender as the transport identifies them: the conversation's contact_identifier and where replies go */
  from: string
  /** text, reaction, or the kind of attachment (the transport's own word for it) */
  type: string
  text?: string
  /** A reaction, as stored in metadata: never content the model reads */
  reaction?: Record<string, unknown> | null
  profileName?: string
  knownContact: Pick<ContactState, 'phone'> | null
}

/** Both transports' words for what arrived, as the placeholder names them */
function placeholderFor(type: string): keyof typeof WHATSAPP_PLACEHOLDER_AR {
  if (type === 'audio') return 'voice'
  if (type === 'image' || type === 'sticker') return 'image'
  // A clip is something to watch, not a file to open
  if (type === 'video') return 'video'
  if (type === 'document' || type === 'file') return 'file'
  // Instagram's names for a shared post and a shared reel (Meta's documented
  // types, not all seen live yet: anything else stays 'unsupported')
  if (type === 'share' || type === 'ig_post') return 'share'
  if (type === 'ig_reel' || type === 'reel') return 'reel'
  return 'unsupported'
}

export function handleInboundWhatsAppMessage({
  supabase,
  channel,
  message,
}: {
  /** The service-role client: the webhook runs as nobody */
  supabase: SupabaseClient
  channel: InboundChannel
  message: InboundWhatsAppMessage
}): Promise<InboundDisposition> {
  return handleInbound(supabase, channel, WHATSAPP, {
    messageId: message.messageId,
    from: message.from,
    type: message.type,
    ...(message.text !== undefined ? { text: message.text } : {}),
    ...(message.type === 'reaction' ? { reaction: message.reaction ?? null } : {}),
    ...(message.profileName ? { profileName: message.profileName } : {}),
    // What the transport knows before the first word (the design's §6)
    knownContact: { phone: normalizePhone(`+${message.from}`) },
  })
}

/**
 * AN INSTAGRAM DIRECT MESSAGE: the same pipeline as WhatsApp and Messenger.
 * No welcome message: a cold DM opens the person's conversation and is
 * answered, exactly as a cold WhatsApp message is. A DM after the comment
 * opener lands in the conversation the opener opened (the same key: the
 * commenter's id is the id their DM carries).
 *
 * ECHOES: OURS OR A PERSON'S AT THE CLINIC, BY THE IDS WE RECORDED, as on
 * Messenger (handleEcho), never by the payload. They arrive on this webhook
 * (the review clinic's log, 2026-11-08), our own opener among them, and the
 * id our send records was checked there to be the echo's mid. Ours is
 * ignored; anything else is a person answering from the Instagram app: it is
 * stored as theirs and the bot stands down.
 *
 * Story mentions are out of this build (§3.5): claimed, logged, left.
 *
 * THE NAME. A conversation that has no name takes the username from the
 * person's comment thread on this channel; with none, the profile is fetched
 * once, when the conversation is opened. If that fails, the inbox's
 * "visitor" plus the id stays.
 */
export async function handleInboundInstagramEvent({
  supabase,
  channel,
  event,
}: {
  supabase: SupabaseClient
  channel: InboundChannel
  event: InboundMessengerEvent
}): Promise<InboundDisposition> {
  if (!isLive(channel)) return { kind: 'inactive' }
  if (event.kind === 'echo') {
    // Ours or a person's at the clinic, by the ids we recorded (handleEcho): the
    // id our send records is the echo's mid, checked on the review clinic's log
    // for the comment opener, 2026-11-08
    const profileName = await nameInstagramConversation(supabase, channel, event.to)
    return handleEcho(supabase, channel, event, INSTAGRAM, profileName ?? undefined)
  }
  if (event.kind === 'message' && event.type === 'story_mention') {
    console.info(`[${SOURCE}] instagram story mention left`, { channelId: channel.id, messageId: event.messageId, hasText: Boolean(event.text?.trim()) })
    return { kind: 'story_mention' }
  }
  const profileName = await nameInstagramConversation(supabase, channel, event.from)
  if (event.kind === 'reaction') {
    return handleInbound(supabase, channel, INSTAGRAM, { messageId: event.claimId, from: event.from, type: 'reaction', reaction: event.reaction, knownContact: null, ...(profileName ? { profileName } : {}) })
  }
  return handleInbound(supabase, channel, INSTAGRAM, {
    messageId: event.messageId,
    from: event.from,
    type: event.type,
    ...(event.text !== undefined ? { text: event.text } : {}),
    ...(profileName ? { profileName } : {}),
    knownContact: null,
  })
}

/**
 * The name for the person's DM conversation, read before it is found or
 * opened. An existing conversation with a name keeps it. One without a name
 * takes the comment thread's username now (filled in here); a conversation
 * about to be opened takes the comment thread's, or else the fetched
 * profile's (returned, for conversationFor to write). Never overwrites a name.
 */
async function nameInstagramConversation(supabase: SupabaseClient, channel: InboundChannel, igsid: string): Promise<string | null> {
  const { data: rows, error } = await supabase
    .from('conversations')
    .select('id, thread, contact_name')
    .eq('channel_id', channel.id)
    .eq('contact_identifier', igsid)
    .returns<{ id: string; thread: string; contact_name: string | null }[]>()
  if (error) throw error
  const dm = rows.find((r) => r.thread === 'dm')
  if (dm?.contact_name) return null
  const fromComments = rows.find((r) => r.thread === 'comments')?.contact_name?.trim() || null
  if (dm) {
    if (fromComments) {
      const { error: updateError } = await supabase.from('conversations').update({ contact_name: fromComments.slice(0, 100) }).eq('id', dm.id).is('contact_name', null)
      if (updateError) console.error(`[${SOURCE}] naming the instagram conversation failed`, { channelId: channel.id, conversationId: dm.id, error: errorForLog(updateError) })
    }
    return null
  }
  return fromComments ?? (await fetchInstagramUsername({ supabase, channelId: channel.id, igsid }))
}

export function handleInboundMessengerEvent({
  supabase,
  channel,
  event,
}: {
  supabase: SupabaseClient
  channel: InboundChannel
  event: InboundMessengerEvent
}): Promise<InboundDisposition> {
  switch (event.kind) {
    case 'echo':
      return handleEcho(supabase, channel, event, MESSENGER)
    case 'reaction':
      return handleInbound(supabase, channel, MESSENGER, { messageId: event.claimId, from: event.from, type: 'reaction', reaction: event.reaction, knownContact: null })
    case 'message':
      return handleInbound(supabase, channel, MESSENGER, {
        messageId: event.messageId,
        from: event.from,
        type: event.type,
        ...(event.text !== undefined ? { text: event.text } : {}),
        knownContact: null,
      })
  }
}

async function handleInbound(supabase: SupabaseClient, channel: InboundChannel, transport: Transport, message: Inbound): Promise<InboundDisposition> {
  if (!isLive(channel)) return { kind: 'inactive' }

  const { conversationId, autoReply } = await conversationFor(supabase, channel, message.from, message.profileName)
  const typeKey = `${transport.name}_type`

  if (message.type === 'reaction') {
    // A thumbs-up is how many people say yes, so it is stored where an agent
    // sees it. It is never answered and never reaches the pipeline: nothing
    // may read it as a confirmation. The emoji stays in metadata, out of the
    // content the model reads as history.
    const { error } = await supabase
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'user', content: WHATSAPP_PLACEHOLDER_AR.reaction, metadata: { [typeKey]: 'reaction', reaction: message.reaction ?? null } })
    if (error) throw error
    console.info(`[${SOURCE}] reaction`, { channelId: channel.id, conversationId, messageId: message.messageId })
    return { kind: 'reaction', conversationId }
  }

  // ANY TYPED WORDS GO TO THE PIPELINE, whatever they came with: a shared
  // post, a reel, an image with a line under it. A placeholder is for a
  // message with nothing to read, not for one whose attachment we cannot
  // open. (Until 2026-11-08 a Messenger image with typed words dropped the
  // words: a bug, not a choice.)
  const isText = Boolean(message.text?.trim())
  if (!isText) {
    // Stored as what it is, so the conversation shows it arrived
    const { error } = await supabase
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'user', content: WHATSAPP_PLACEHOLDER_AR[placeholderFor(message.type)], metadata: { [typeKey]: message.type } })
    if (error) throw error
    // A person has the conversation: they can listen. Otherwise the bot says text only, once per run
    const send = autoReply ? await notice(supabase, transport, channel.id, conversationId, message.from, 'unsupported', WHATSAPP_UNSUPPORTED_AR) : 'none'
    console.info(`[${SOURCE}] not text`, { channelId: channel.id, conversationId, messageId: message.messageId, type: message.type, send })
    return { kind: 'not_text', type: message.type, conversationId, send }
  }
  const text = message.text!.trim().slice(0, 4096)

  const { data: userMessage, error: userMessageError } = await supabase
    .from('messages')
    // What the words came with is kept beside them, out of the content the model reads
    .insert({ conversation_id: conversationId, role: 'user', content: text, ...(message.type !== 'text' ? { metadata: { [typeKey]: message.type } } : {}) })
    .select('id')
    .single<{ id: string }>()
  if (userMessageError) throw userMessageError

  // The reply row is written by the pipeline; it is written as 'sending', and its id kept for the send's answer
  let replyRowId: string | null = null
  const store = trackedStore(
    conversationStore({ supabase, clientId: channel.client_id, conversationId, source: SOURCE }),
    supabase,
    conversationId,
    transport,
    (id) => {
      replyRowId = id
    }
  )

  const outcome = await replyToMessage({
    supabase,
    channel,
    conversationId,
    autoReply,
    userMessage,
    message: text,
    store,
    source: SOURCE,
    knownContact: message.knownContact,
    surface: transport.name,
  })

  let send: Sent = 'none'
  switch (outcome.kind) {
    case 'reply':
    case 'fallback':
      send = await sendRow(supabase, transport, channel.id, conversationId, replyRowId, message.from, outcome.reply)
      break
    case 'handoff':
      send = await notice(supabase, transport, channel.id, conversationId, message.from, 'handoff', WHATSAPP_HANDOFF_AR)
      break
    case 'unavailable':
      send = await notice(supabase, transport, channel.id, conversationId, message.from, 'unavailable', WHATSAPP_UNAVAILABLE_AR)
      break
  }
  console.info(`[${SOURCE}] answered`, { channelId: channel.id, conversationId, messageId: message.messageId, outcome: outcome.kind, send })
  return { kind: 'answered', conversationId, outcome: outcome.kind, send }
}

/**
 * The sender's direct-message conversation on this channel, by the id Meta
 * gives (the number, or the PSID); opened on their first message. One per
 * person: the database refuses a second (conversations_one_per_contact), so
 * two first messages at once both land in the one that was opened. THE KEY IS
 * (channel, contact, thread 'dm') and nothing else: never the id alone, never
 * a lookup that turns one id into another. A comment thread with the same
 * person on the same channel is a different conversation (thread
 * 'comments'), because on Facebook a commenter's id is their PSID and the
 * public side must never read the private one.
 */
export async function conversationFor(supabase: SupabaseClient, channel: InboundChannel, contact: string, profileName?: string) {
  const find = async () => {
    const { data, error } = await supabase
      .from('conversations')
      .select('id, auto_reply_enabled')
      .eq('channel_id', channel.id)
      .eq('contact_identifier', contact)
      .eq('thread', 'dm')
      .maybeSingle<{ id: string; auto_reply_enabled: boolean }>()
    if (error) throw error
    return data ? { conversationId: data.id, autoReply: data.auto_reply_enabled } : null
  }
  const existing = await find()
  if (existing) return existing

  const { data: created, error: insertError } = await supabase
    .from('conversations')
    .insert({
      client_id: channel.client_id,
      channel_id: channel.id,
      contact_identifier: contact,
      contact_name: profileName?.trim().slice(0, 100) || null,
      thread: 'dm',
      status: 'new',
    })
    .select('id')
    .single<{ id: string }>()
  if (insertError) {
    // Two messages from one person at once: the other one opened it first
    // (conversations_one_per_contact, 20261114100000). That one is theirs
    if (insertError.code === '23505') {
      const winner = await find()
      if (winner) return winner
    }
    throw insertError
  }
  return { conversationId: created.id, autoReply: true }
}

type SendRecord = { transport: string; state: 'sending' | 'sent' | 'failed'; messageId?: string | null }
const sending = (transport: Transport): SendRecord => ({ transport: transport.name, state: 'sending' })

/** The pipeline's store, with the reply row written as 'sending' and its id handed back */
function trackedStore(base: ReplyStore, supabase: SupabaseClient, conversationId: string, transport: Transport, onRow: (id: string) => void): ReplyStore {
  return {
    ...base,
    async insertReply(row) {
      // conversations.last_message_* is kept current by a trigger on messages
      const { data, error } = await supabase
        .from('messages')
        .insert({ conversation_id: conversationId, role: 'assistant', content: row.content, metadata: { ...row.metadata, send: sending(transport) } })
        .select('id')
        .single<{ id: string }>()
      if (data) onRow(data.id)
      return { error }
    },
  }
}

/** Sends a row already written as 'sending', and records what became of it */
async function sendRow(supabase: SupabaseClient, transport: Transport, channelId: string, conversationId: string, rowId: string | null, to: string, body: string): Promise<Sent> {
  const result = await transport.send({ supabase, channelId, to, body })
  if (!rowId) {
    console.error(`[${SOURCE}] a reply was sent without its row id: its send is not recorded`, { channelId, conversationId, send: result.kind })
    return result.kind
  }
  // A WhatsApp status that came before this answer is applied here (src/lib/meta/delivery.ts)
  await recordResult(supabase, rowId, transport.name, result)
  return result.kind
}

type Notice = 'handoff' | 'unavailable' | 'unsupported'
type Outbound = { role: string; content: string; metadata: { notice?: string } | null }

/**
 * Whether a notice still has something to say, read from the conversation's
 * outbound messages, newest first:
 *   handoff      stops at the first human agent's message (a person has
 *                spoken: nothing left to say) or at an earlier handoff notice
 *                (already told); an ordinary bot reply means a new stretch.
 *   unavailable  not if the last outbound message is already it.
 *   unsupported  not if the last outbound message is already it (a second
 *                voice note in a row); anything else said since means it is
 *                due again.
 */
function stillDue(kind: Notice, outbound: Outbound[]) {
  for (const message of outbound) {
    const notice = message.metadata?.notice
    if (kind === 'handoff') {
      if (message.role === 'agent') return false
      if (notice === 'handoff') return false
      if (!notice) return true
      continue
    }
    return notice !== kind
  }
  return true
}

/** A notice the clinic speaks: written to the conversation first, as 'sending', then sent, and its send recorded */
async function notice(supabase: SupabaseClient, transport: Transport, channelId: string, conversationId: string, to: string, kind: Notice, body: string): Promise<Sent> {
  const { data: outbound, error } = await supabase
    .from('messages')
    .select('role, content, metadata')
    .eq('conversation_id', conversationId)
    .in('role', ['assistant', 'agent'])
    .order('created_at', { ascending: false })
    .limit(50)
    .returns<Outbound[]>()
  if (error) throw error
  if (!stillDue(kind, outbound)) return 'already_told'

  const { data: row, error: insertError } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role: 'assistant', content: body, metadata: { notice: kind, transport: transport.name, send: sending(transport) } })
    .select('id')
    .single<{ id: string }>()
  if (insertError) throw insertError
  return sendRow(supabase, transport, channelId, conversationId, row.id, to, body)
}

type OutboundRow = { id: string; content: string; metadata: RowMetadata | null }

/**
 * THE PAGE SENT A MESSAGE: OURS, OR A PERSON AT THE CLINIC'S.
 *
 * Ours is decided by what we sent, never by a field of the echo (its app_id
 * is one Meta might stop sending, or send for both):
 *   1. a row of the conversation carries the echo's mid as its sent id: ours.
 *   2. otherwise the send's answer has not been recorded yet (the echo can
 *      arrive first) or the send timed out after Meta took it: a row still
 *      'sending' or 'failed', with no id, whose text is the echo's text, is
 *      that message. It takes the mid, and is delivered. The text has to
 *      match as well as the send being in flight: a person typing in the
 *      inbox while our reply is on its way is a person, and their message
 *      must not be swallowed as ours.
 *   3. anything else is a person at the clinic. It is stored as an agent
 *      message, which hands the conversation to people (the
 *      sync_conversation_last_message trigger turns auto-reply off), exactly
 *      as a reply from the dashboard does. An echo to someone with no
 *      conversation yet (the clinic wrote first) opens one.
 *
 * Getting 1 or 2 wrong would file the bot's own reply as a person's and
 * silence the bot on the conversations it is answering: that is why the
 * intent is recorded before the send.
 */
async function handleEcho(
  supabase: SupabaseClient,
  channel: InboundChannel,
  echo: Extract<InboundMessengerEvent, { kind: 'echo' }>,
  transport: Transport,
  profileName?: string
): Promise<InboundDisposition> {
  if (!isLive(channel)) return { kind: 'inactive' }
  const { conversationId } = await conversationFor(supabase, channel, echo.to, profileName)

  const { data: rows, error } = await supabase
    .from('messages')
    .select('id, content, metadata')
    .eq('conversation_id', conversationId)
    // A person's reply from the dashboard is sent by us too, and echoed like the bot's
    .in('role', ['assistant', 'agent'])
    .order('created_at', { ascending: false })
    .limit(50)
    .returns<OutboundRow[]>()
  if (error) throw error

  if (rows.some((row) => row.metadata?.send?.messageId === echo.messageId)) {
    console.info(`[${SOURCE}] echo of ours`, { channelId: channel.id, conversationId, messageId: echo.messageId })
    return { kind: 'echo_ours', conversationId }
  }

  const echoed = echo.text?.trim()
  const inFlight = echoed
    ? rows.find((row) => {
        const send = row.metadata?.send
        return (send?.state === 'sending' || send?.state === 'failed') && !send.messageId && row.content.trim() === echoed
      })
    : undefined
  if (inFlight) {
    // Delivered after all: a failure marker on it would be wrong
    const rest: RowMetadata = { ...(inFlight.metadata ?? {}) }
    delete rest.delivery
    const { error: updateError } = await supabase
      .from('messages')
      .update({ metadata: { ...rest, send: { transport: transport.name, state: 'sent', messageId: echo.messageId } } })
      .eq('id', inFlight.id)
    if (updateError) throw updateError
    console.info(`[${SOURCE}] echo of ours, before its send was recorded`, { channelId: channel.id, conversationId, messageId: echo.messageId })
    return { kind: 'echo_ours', conversationId }
  }

  const content = echoed || WHATSAPP_PLACEHOLDER_AR[placeholderFor(echo.type)]
  const { error: insertError } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role: 'agent', content, metadata: { transport: transport.name, echo: true, messageId: echo.messageId, [`${transport.name}_type`]: echo.type } })
  if (insertError) throw insertError
  console.info(`[${SOURCE}] echo of a person at the clinic`, { channelId: channel.id, conversationId, messageId: echo.messageId })
  return { kind: 'echo_agent', conversationId }
}
