import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { recordFailed, recordResult } from '@/lib/meta/delivery'
import { sendInstagramText, sendMessengerText, sendWhatsAppText, type SendResult } from '@/lib/meta/send'
import type { ChannelType } from '@/lib/types/channels'
import { REPLY_WINDOW_MS, fitsChannel, type ReplyAvailability, type ReplyBlock } from '@/lib/types/conversations'
import { errorForLog } from '@/lib/log'

/**
 * A PERSON'S REPLY FROM THE DASHBOARD, SENT (.scratch/agent-reply-decisions.md §2).
 *
 * Until 2026-11-08 a reply typed in the inbox was saved and never left, on
 * WhatsApp, Messenger and Instagram: the employee saw it on screen and the
 * patient never got it. It now goes out through the channel's transport,
 * and its row says what became of it (src/lib/meta/delivery.ts).
 *
 * THE WEBSITE IS NOT A SEND. The widget is told of an agent row by a
 * database broadcast and fetches what it missed when it reconnects
 * (20260927110000_widget_agent_broadcast.sql): the visitor's browser pulls
 * the reply, so there is nothing here to fail, and a website row carries no
 * send state. That path is unchanged.
 *
 * Before anything is typed, the reply box is closed when the reply cannot
 * go (replyAvailability): the channel, client or organization is off; the
 * channel has no token or account id; the person last wrote more than 24
 * hours ago; or the conversation is a public Instagram comment thread, where
 * a reply would land in the person's private messages. The same check runs
 * again at send time, because any of it can change while the page is open;
 * a reply caught by it then is stored as failed with its reason, not sent.
 *
 * THE WINDOW IS OUR ESTIMATE: 24 hours from when we received the person's
 * last message (a reaction does not count). A conversation with no message
 * from the person at all (the clinic wrote first, or only the comment opener
 * went) has no window we can see, so the box stays open and Meta's own
 * answer decides. Either way Meta's refusal is handled when it comes.
 *
 * Runs with the service-role client: the token is readable by it alone.
 * Every query is scoped to the one conversation.
 */

type ReplyChannel = {
  id: string
  type: ChannelType
  is_active: boolean
  external_id: string | null
  clients: { status: string; organizations: { is_active: boolean } | null } | null
}

export type ReplyConversation = {
  id: string
  thread: 'dm' | 'comments'
  contact_identifier: string | null
  channel: ReplyChannel
}

/** The conversation as the reply needs it, read with the service role (the caller has checked the user may see it) */
export async function loadForReply(admin: SupabaseClient, conversationId: string): Promise<ReplyConversation | null> {
  const { data, error } = await admin
    .from('conversations')
    .select('id, thread, contact_identifier, channel:channels!inner(id, type, is_active, external_id, clients(status, organizations(is_active)))')
    .eq('id', conversationId)
    .maybeSingle<ReplyConversation>()
  if (error) throw error
  return data
}

const isMeta = (type: ChannelType) => type !== 'website'

export async function replyAvailability(admin: SupabaseClient, conversation: ReplyConversation, now = Date.now()): Promise<ReplyAvailability> {
  const { channel } = conversation
  if (!isMeta(channel.type)) return { blocked: null, windowEndsAt: null }
  if (conversation.thread === 'comments') return { blocked: 'comment_thread', windowEndsAt: null }

  const live = channel.is_active && channel.clients?.status === 'active' && channel.clients.organizations?.is_active === true
  if (!live) return { blocked: 'paused', windowEndsAt: null }

  const { data: secret, error: secretError } = await admin
    .from('channel_secrets')
    .select('access_token')
    .eq('channel_id', channel.id)
    .maybeSingle<{ access_token: string | null }>()
  if (secretError) throw secretError
  if (!secret?.access_token || !channel.external_id || !conversation.contact_identifier) return { blocked: 'disconnected', windowEndsAt: null }

  const lastWrote = await lastPersonMessageAt(admin, conversation.id)
  if (!lastWrote) return { blocked: null, windowEndsAt: null }
  const windowEndsAt = new Date(new Date(lastWrote).getTime() + REPLY_WINDOW_MS)
  return { blocked: windowEndsAt.getTime() <= now ? 'outside_window' : null, windowEndsAt: windowEndsAt.toISOString() }
}

/** When the person last wrote: their newest row that is not a reaction */
async function lastPersonMessageAt(admin: SupabaseClient, conversationId: string) {
  const { data, error } = await admin
    .from('messages')
    .select('created_at, metadata')
    .eq('conversation_id', conversationId)
    .eq('role', 'user')
    .order('created_at', { ascending: false })
    .limit(20)
    .returns<{ created_at: string; metadata: Record<string, unknown> | null }[]>()
  if (error) throw error
  const isReaction = (metadata: Record<string, unknown> | null) => metadata?.whatsapp_type === 'reaction' || metadata?.messenger_type === 'reaction' || metadata?.instagram_type === 'reaction'
  return data.find((row) => !isReaction(row.metadata))?.created_at ?? null
}

/** Each Meta channel's transport: its name on the row, and its send */
const TRANSPORTS: Record<Exclude<ChannelType, 'website'>, { name: string; send: typeof sendWhatsAppText }> = {
  whatsapp: { name: 'whatsapp', send: sendWhatsAppText },
  facebook: { name: 'messenger', send: sendMessengerText },
  instagram: { name: 'instagram', send: sendInstagramText },
}

export function transportName(type: ChannelType) {
  return isMeta(type) ? TRANSPORTS[type as Exclude<ChannelType, 'website'>].name : null
}

/** What a closed box means for a reply that got past it: a stored failure, never a send */
const BLOCK_FAILURE: Record<Exclude<ReplyBlock, 'comment_thread'>, 'paused' | 'disconnected' | 'outside_window'> = {
  paused: 'paused',
  disconnected: 'disconnected',
  outside_window: 'outside_window',
}

/**
 * Sends an agent row already written as 'sending' and records what became
 * of it. Checked again first: a reply the box should have stopped is stored
 * as failed with its reason, and nothing is attempted.
 */
export async function deliverAgentReply(admin: SupabaseClient, conversation: ReplyConversation, rowId: string, text: string): Promise<void> {
  const type = conversation.channel.type
  if (!isMeta(type)) return
  const transport = TRANSPORTS[type as Exclude<ChannelType, 'website'>]

  const { blocked } = await replyAvailability(admin, conversation)
  if (blocked === 'comment_thread') throw new Error('a reply in a comment thread is never sent')
  if (blocked) {
    await recordFailed(admin, rowId, transport.name, { reason: BLOCK_FAILURE[blocked], kind: 'blocked' })
    console.warn('[agent-reply] not sent', { conversationId: conversation.id, messageId: rowId, reason: blocked })
    return
  }
  if (!fitsChannel(type, text)) {
    await recordFailed(admin, rowId, transport.name, { reason: 'too_long', kind: 'unsendable' })
    return
  }

  let result: SendResult
  try {
    result = await transport.send({ supabase: admin, channelId: conversation.channel.id, to: conversation.contact_identifier!, body: text })
  } catch (error) {
    // Reading the token failed: nothing was sent
    console.error('[agent-reply] the send could not start', { conversationId: conversation.id, messageId: rowId, error: errorForLog(error) })
    result = { kind: 'failed', status: null, code: null, attempts: 0 }
  }
  await recordResult(admin, rowId, transport.name, result)
  console.info('[agent-reply] send', { conversationId: conversation.id, messageId: rowId, send: result.kind })
}
