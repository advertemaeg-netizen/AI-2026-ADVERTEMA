import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { conversationStore, replyToMessage, type ReplyOutcome } from '@/lib/ai/reply'
import { sendWhatsAppText, type SendResult } from '@/lib/meta/send'
import type { InboundWhatsAppMessage } from '@/lib/meta/webhook'
import {
  WHATSAPP_HANDOFF_AR,
  WHATSAPP_PLACEHOLDER_AR,
  WHATSAPP_UNAVAILABLE_AR,
  WHATSAPP_UNSUPPORTED_AR,
} from '@/lib/meta/whatsapp-notices-ar'
import { normalizePhone } from '@/lib/phone'

/**
 * WHATSAPP IS A TRANSPORT FOR THE PIPELINE WE HAVE (.scratch/whatsapp-send-design.md
 * §0, §5). An inbound text message is given the same treatment a widget
 * message gets: the conversation is found or opened for the sender, the
 * message is stored, replyToMessage() does everything the website does, and
 * the outcome goes back out through sendWhatsAppText(). Nothing here holds a
 * conversation, writes a lead or decides a booking: that is the pipeline's,
 * and it is one function for every transport.
 *
 * What differs from the website is what the transport knows and what it can
 * show. The sender's number arrives with the delivery, so it enters the
 * pipeline as the known contact: told to the model as on record, written
 * onto the lead when one opens, never asked for. And there is no widget to
 * show a notice, so where the website delivers no text the clinic speaks:
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
 * A message that is not text (a voice note, above all: a large share of
 * people message a business that way) is stored as a placeholder saying
 * what arrived, so the conversation shows it and an agent can tell. It gets
 * one reply in the bot's voice saying text only, once per run (not for a
 * second voice note in a row), and none while a person has the
 * conversation: they can listen. A reaction is stored the same way and
 * never answered: it never enters the pipeline, so nothing can take a
 * thumbs-up for a confirmation.
 *
 * Every notice is written to the conversation as a message, because on
 * WhatsApp it reached a customer's phone: an agent opening the conversation
 * sees what the customer was told. The unavailable text is ours, not the
 * client's settings, because settings failing to load is one of the ways
 * here. And a reply that was stored but not sent is marked on its row
 * (metadata.delivery): an answer the customer never received must not read
 * in the dashboard as one they did.
 *
 * NEVER LOGGED: the text, the sender's number, the profile name. Logged: the
 * channel id, the conversation id, the wamid, the outcome and send kinds.
 */

const SOURCE = 'webhook/meta'

export type InboundChannel = {
  id: string
  client_id: string
  is_active: boolean
  clients: { name: string; industry: string | null; description: string | null; status: string; organizations: { is_active: boolean } | null } | null
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

/** WhatsApp's message types, as the placeholder names them */
function placeholderFor(type: string): keyof typeof WHATSAPP_PLACEHOLDER_AR {
  if (type === 'audio') return 'voice'
  if (type === 'image' || type === 'sticker') return 'image'
  // A clip is something to watch, not a file to open
  if (type === 'video') return 'video'
  if (type === 'document') return 'file'
  return 'unsupported'
}

export async function handleInboundWhatsAppMessage({
  supabase,
  channel,
  message,
}: {
  /** The service-role client: the webhook runs as nobody */
  supabase: SupabaseClient
  channel: InboundChannel
  message: InboundWhatsAppMessage
}): Promise<InboundDisposition> {
  if (!isLive(channel)) return { kind: 'inactive' }

  const { conversationId, autoReply } = await conversationFor(supabase, channel, message)

  if (message.type === 'reaction') {
    // A thumbs-up is how many people say yes, so it is stored where an agent
    // sees it. It is never answered and never reaches the pipeline: nothing
    // may read it as a confirmation. The emoji stays in metadata, out of the
    // content the model reads as history.
    const { error } = await supabase
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'user', content: WHATSAPP_PLACEHOLDER_AR.reaction, metadata: { whatsapp_type: 'reaction', reaction: message.reaction ?? null } })
    if (error) throw error
    console.info(`[${SOURCE}] reaction`, { channelId: channel.id, conversationId, messageId: message.messageId })
    return { kind: 'reaction', conversationId }
  }

  const isText = message.type === 'text' && Boolean(message.text?.trim())
  if (!isText) {
    // Stored as what it is, so the conversation shows it arrived
    const { error } = await supabase
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'user', content: WHATSAPP_PLACEHOLDER_AR[placeholderFor(message.type)], metadata: { whatsapp_type: message.type } })
    if (error) throw error
    // A person has the conversation: they can listen. Otherwise the bot says text only, once per run
    const send = autoReply ? await notice(supabase, channel.id, conversationId, message.from, 'unsupported', WHATSAPP_UNSUPPORTED_AR) : 'none'
    console.info(`[${SOURCE}] not text`, { channelId: channel.id, conversationId, messageId: message.messageId, type: message.type, send })
    return { kind: 'not_text', type: message.type, conversationId, send }
  }
  const text = message.text!.trim().slice(0, 4096)

  const { data: userMessage, error: userMessageError } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role: 'user', content: text })
    .select('id')
    .single<{ id: string }>()
  if (userMessageError) throw userMessageError

  const outcome = await replyToMessage({
    supabase,
    channel,
    conversationId,
    autoReply,
    userMessage,
    message: text,
    store: conversationStore({ supabase, clientId: channel.client_id, conversationId, source: SOURCE }),
    source: SOURCE,
    // What the transport knows before the first word (the design's §6)
    knownContact: { phone: normalizePhone(`+${message.from}`) },
  })

  let send: Sent = 'none'
  switch (outcome.kind) {
    case 'reply':
    case 'fallback': {
      const result = await sendWhatsAppText({ supabase, channelId: channel.id, to: message.from, body: outcome.reply })
      send = result.kind
      if (result.kind !== 'sent') await markUndelivered(supabase, conversationId, null, result)
      break
    }
    case 'handoff':
      send = await notice(supabase, channel.id, conversationId, message.from, 'handoff', WHATSAPP_HANDOFF_AR)
      break
    case 'unavailable':
      send = await notice(supabase, channel.id, conversationId, message.from, 'unavailable', WHATSAPP_UNAVAILABLE_AR)
      break
  }
  console.info(`[${SOURCE}] answered`, { channelId: channel.id, conversationId, messageId: message.messageId, outcome: outcome.kind, send })
  return { kind: 'answered', conversationId, outcome: outcome.kind, send }
}

/** The sender's conversation on this channel, by the number Meta gives; opened on their first message */
async function conversationFor(supabase: SupabaseClient, channel: InboundChannel, message: InboundWhatsAppMessage) {
  const { data: existing, error } = await supabase
    .from('conversations')
    .select('id, auto_reply_enabled')
    .eq('channel_id', channel.id)
    .eq('contact_identifier', message.from)
    .maybeSingle<{ id: string; auto_reply_enabled: boolean }>()
  if (error) throw error
  if (existing) return { conversationId: existing.id, autoReply: existing.auto_reply_enabled }

  const { data: created, error: insertError } = await supabase
    .from('conversations')
    .insert({
      client_id: channel.client_id,
      channel_id: channel.id,
      contact_identifier: message.from,
      contact_name: message.profileName?.trim().slice(0, 100) || null,
      status: 'new',
    })
    .select('id')
    .single<{ id: string }>()
  if (insertError) throw insertError
  return { conversationId: created.id, autoReply: true }
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

/** A notice the clinic speaks: written to the conversation first, then sent, and marked if the send failed */
async function notice(supabase: SupabaseClient, channelId: string, conversationId: string, to: string, kind: Notice, body: string): Promise<Sent> {
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
    .insert({ conversation_id: conversationId, role: 'assistant', content: body, metadata: { notice: kind, transport: 'whatsapp' } })
    .select('id')
    .single<{ id: string }>()
  if (insertError) throw insertError
  const result = await sendWhatsAppText({ supabase, channelId, to, body })
  if (result.kind !== 'sent') await markUndelivered(supabase, conversationId, row.id, result)
  return result.kind
}

/**
 * The reply row the customer never received, marked so the dashboard can
 * show it (metadata.delivery). Visibility only: no retry, no queue. With no
 * id the row is the conversation's newest assistant message, the one the
 * pipeline just wrote.
 */
async function markUndelivered(supabase: SupabaseClient, conversationId: string, messageId: string | null, result: Exclude<SendResult, { kind: 'sent' }>) {
  const target = messageId
    ? await supabase.from('messages').select('id, metadata').eq('id', messageId).maybeSingle<{ id: string; metadata: Record<string, unknown> | null }>()
    : await supabase
        .from('messages')
        .select('id, metadata')
        .eq('conversation_id', conversationId)
        .eq('role', 'assistant')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle<{ id: string; metadata: Record<string, unknown> | null }>()
  if (target.error) throw target.error
  if (!target.data) return
  const delivery = { transport: 'whatsapp', failed: result.kind, at: new Date().toISOString(), ...('code' in result ? { code: result.code } : {}), ...('status' in result ? { status: result.status } : {}) }
  const { error } = await supabase
    .from('messages')
    .update({ metadata: { ...(target.data.metadata ?? {}), delivery } })
    .eq('id', target.data.id)
  if (error) console.error(`[${SOURCE}] marking the undelivered reply failed`, { conversationId, messageId: target.data.id, error })
}
