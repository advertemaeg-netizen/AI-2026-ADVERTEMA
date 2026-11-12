'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession, isImpersonating } from '@/lib/auth/session'
import { recordImpersonationAction } from '@/lib/auth/impersonation'
import { getConversationLeads } from '@/lib/lead-visits'
import { deliverAgentReply, loadForReply, replyAvailability, transportName } from '@/lib/agent-reply'
import { createAdminClient } from '@/lib/supabase/admin'
import { UUID_PATTERN } from '@/lib/types/clients'
import { rangeStart, searchTerm } from '@/lib/list-filters'
import {
  CONVERSATION_STATUSES,
  type ConversationActionResult,
  type ConversationDetail,
  type ConversationFilters,
  type ConversationListItem,
  type ConversationStatus,
  RETRYABLE_FAILURES,
  isStuck,
  type Message,
  type MessageSend,
  type ReplyAvailability,
  type TeamMember,
} from '@/lib/types/conversations'
import type { LeadVisit } from '@/lib/types/leads'
import type { ConversationOrigin } from '@/lib/types/comments'
import { errorForLog } from '@/lib/log'

const INBOX_PATH = '/[locale]/dashboard/conversations'
const LIST_LIMIT = 100
const MAX_MESSAGE_LENGTH = 4000

const LIST_COLUMNS = `
  id, status, contact_name, contact_identifier, last_message_at,
  last_message_preview, last_message_role, assigned_to, needs_human_since, needs_human_reason,
  client:clients!inner(id, name),
  channel:channels!inner(id, type, name)
`

const DETAIL_COLUMNS = `
  id, status, contact_name, contact_identifier, last_message_at,
  last_message_preview, last_message_role, assigned_to, needs_human_since, needs_human_reason, created_at, auto_reply_enabled, thread,
  client:clients!inner(id, name, industry, status),
  channel:channels!inner(id, type, name)
`

// The send state and a bot reply's failure only: the rest of metadata stays on the server
const MESSAGE_COLUMNS = 'id, conversation_id, role, content, sender_id, created_at, send:metadata->send, delivery:metadata->delivery'

export async function getConversations(
  filters: ConversationFilters = {}
): Promise<ConversationListItem[]> {
  const { supabase, profile } = await getSession()
  if (!profile) return []

  let query = supabase
    .from('conversations')
    .select(LIST_COLUMNS)
    // Private messages only: a comment thread is the comments tab's (src/lib/actions/comments.ts)
    .neq('thread', 'comments')
    .order('last_message_at', { ascending: false })
    .limit(LIST_LIMIT)

  if (filters.clientId) query = query.eq('client_id', filters.clientId)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.channelType) query = query.eq('channel.type', filters.channelType)
  if (filters.range) query = query.gte('last_message_at', rangeStart(filters.range))

  const term = filters.q ? searchTerm(filters.q) : ''
  if (term) {
    query = query.or(
      `contact_name.ilike.%${term}%,contact_identifier.ilike.%${term}%,last_message_preview.ilike.%${term}%`
    )
  }

  const { data, error } = await query.returns<ConversationListItem[]>()
  if (error) throw new Error(`Failed to load conversations: ${error.code}`)
  return data
}

export async function getConversation(id: string): Promise<{
  conversation: ConversationDetail
  messages: Message[]
  team: TeamMember[]
  leads: LeadVisit[]
  /** Whether the reply box is open, and when the 24-hour window closes */
  reply: ReplyAvailability
  /** The comment it began from, when it began from one (the opener's metadata.origin, src/lib/meta/comments.ts) */
  origin: ConversationOrigin | null
} | null> {
  if (!UUID_PATTERN.test(id)) return null
  const { supabase, profile } = await getSession()
  if (!profile) return null

  const { data: conversation, error } = await supabase
    .from('conversations')
    .select(DETAIL_COLUMNS)
    .eq('id', id)
    .maybeSingle<ConversationDetail>()

  if (error) throw new Error(`Failed to load conversation: ${error.code}`)
  if (!conversation) return null

  const [messagesResult, teamResult, leads, originResult] = await Promise.all([
    supabase
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .returns<Message[]>(),
    supabase.rpc('client_team', { check_client_id: conversation.client.id }),
    getConversationLeads(supabase, id),
    supabase
      .from('messages')
      .select('origin:metadata->origin')
      .eq('conversation_id', id)
      .not('metadata->origin', 'is', null)
      .limit(1)
      .returns<{ origin: { commentId?: unknown } | null }[]>(),
  ])

  if (messagesResult.error) {
    throw new Error(`Failed to load messages: ${messagesResult.error.code}`)
  }
  if (teamResult.error) console.error('[conversations] client_team', errorForLog(teamResult.error))
  // Without it the line at the top is missing, and nothing else: logged, not thrown
  if (originResult.error) console.error('[conversations] origin', errorForLog(originResult.error))
  const opener = originResult.data?.[0]?.origin
  const origin: ConversationOrigin | null = opener
    ? { commentId: typeof opener.commentId === 'string' ? opener.commentId : null }
    : null

  // The user can see the conversation (read above under RLS); its channel's
  // state and token are read with the service role, which alone may
  const admin = createAdminClient()
  const forReply = await loadForReply(admin, id)
  const reply: ReplyAvailability = forReply ? await replyAvailability(admin, forReply) : { blocked: null, windowEndsAt: null }

  return {
    conversation,
    messages: messagesResult.data,
    team: (teamResult.data as TeamMember[] | null) ?? [],
    leads,
    reply,
    origin,
  }
}

/**
 * A person's reply from the inbox. On the website it is saved and the widget
 * fetches it; on WhatsApp, Messenger and Instagram it is saved as 'sending',
 * sent through the channel's transport, and returned with what became of it
 * (src/lib/agent-reply.ts). A failed send is a state on the row, not a toast:
 * the conversation is marked for a person by the database
 * (agent_send_outcome), and the box still hands the conversation over (the
 * insert turns auto-reply off, whatever the send then does).
 *
 * The insert is the user's own, under RLS: it is what proves they may write
 * in this conversation. The send runs with the service role: the token is
 * readable by it alone.
 */
export async function sendAgentMessage(
  conversationId: string,
  content: string
): Promise<ConversationActionResult<Message>> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!UUID_PATTERN.test(conversationId)) return { ok: false, error: 'notFound' }

  const text = content.trim()
  if (!text || text.length > MAX_MESSAGE_LENGTH) return { ok: false, error: 'validation' }

  // Visible to the user first, then read whole with the service role
  const { data: visible } = await supabase.from('conversations').select('id').eq('id', conversationId).maybeSingle<{ id: string }>()
  if (!visible) return { ok: false, error: 'notFound' }
  const admin = createAdminClient()
  const conversation = await loadForReply(admin, conversationId)
  if (!conversation) return { ok: false, error: 'notFound' }
  // A public comment thread: a reply here would land in the person's private messages
  if (conversation.thread === 'comments') return { ok: false, error: 'forbidden' }
  const transport = transportName(conversation.channel.type)

  // RLS only allows role='agent' + sender_id = current user, and only on
  // conversations this user can see
  const { data: message, error } = await supabase
    .from('messages')
    .insert({
      conversation_id: conversationId,
      role: 'agent',
      content: text,
      sender_id: profile.id,
      ...(transport ? { metadata: { transport, send: { transport, state: 'sending' } } } : {}),
    })
    .select(MESSAGE_COLUMNS)
    .single<Message>()

  if (error) {
    if (error.code === '42501') return { ok: false, error: 'notFound' }
    console.error('[conversations] sendAgentMessage', errorForLog(error))
    return { ok: false, error: 'unknown' }
  }

  // A human replying means the conversation is being worked on
  await supabase
    .from('conversations')
    .update({ status: 'in_progress' })
    .eq('id', conversationId)
    .eq('status', 'new')

  const sent = transport ? await deliverAndRead(admin, conversation, message) : message
  revalidatePath(INBOX_PATH, 'page')
  return { ok: true, data: sent }
}

/** Sends the row and reads it back with what became of it */
async function deliverAndRead(admin: ReturnType<typeof createAdminClient>, conversation: NonNullable<Awaited<ReturnType<typeof loadForReply>>>, message: Message) {
  try {
    await deliverAgentReply(admin, conversation, message.id, message.content)
  } catch (error) {
    // Left 'sending': the inbox shows it as stuck after a few minutes, with "send again"
    console.error('[conversations] delivering an agent reply failed', { messageId: message.id, error: errorForLog(error) })
  }
  const { data } = await admin.from('messages').select(MESSAGE_COLUMNS).eq('id', message.id).maybeSingle<Message>()
  return data ?? message
}

/**
 * "Send again", on a reply that failed for a reason that might have passed
 * (refused, or stuck mid-send). Not on the others: outside the window,
 * paused, disconnected and too long fail the same way until something
 * changes, and their line says what. The same row is sent again, so the
 * conversation shows one message; the state moves to 'sending' only if it
 * is still what the user saw, so a double click sends once.
 */
export async function retryAgentMessage(messageId: string): Promise<ConversationActionResult<Message>> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!UUID_PATTERN.test(messageId)) return { ok: false, error: 'notFound' }

  const { data: visible } = await supabase
    .from('messages')
    .select(MESSAGE_COLUMNS)
    .eq('id', messageId)
    .eq('role', 'agent')
    .maybeSingle<Message>()
  if (!visible) return { ok: false, error: 'notFound' }

  const send = visible.send
  const stuck = isStuck(visible)
  const failure = stuck ? 'stuck' : send?.state === 'failed' ? send.reason : undefined
  if (!send || !failure || !RETRYABLE_FAILURES.includes(failure)) return { ok: false, error: 'validation' }

  const admin = createAdminClient()
  const conversation = await loadForReply(admin, visible.conversation_id)
  if (!conversation || conversation.thread === 'comments') return { ok: false, error: 'notFound' }
  const { data: row } = await admin.from('messages').select('metadata').eq('id', messageId).maybeSingle<{ metadata: Record<string, unknown> | null }>()
  const sending: MessageSend = { transport: send.transport, state: 'sending', at: new Date().toISOString() }
  const { data: claimed } = await admin
    .from('messages')
    .update({ metadata: { ...(row?.metadata ?? {}), send: sending } })
    .eq('id', messageId)
    .eq('metadata->send->>state', send.state)
    .select('id')
  if (!claimed || claimed.length === 0) return { ok: false, error: 'validation' }

  const sent = await deliverAndRead(admin, conversation, { ...visible, send: sending })
  revalidatePath(INBOX_PATH, 'page')
  return { ok: true, data: sent }
}

export async function updateConversationStatus(
  id: string,
  status: ConversationStatus
): Promise<ConversationActionResult> {
  // A support tool: allowed while a super admin views the account (and counted)
  const { supabase, profile, impersonation } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!UUID_PATTERN.test(id)) return { ok: false, error: 'notFound' }
  if (!(CONVERSATION_STATUSES as readonly string[]).includes(status)) {
    return { ok: false, error: 'validation' }
  }

  const { data, error } = await supabase
    .from('conversations')
    .update({ status })
    .eq('id', id)
    .select('id')

  if (error) {
    console.error('[conversations] updateConversationStatus', errorForLog(error))
    return { ok: false, error: 'unknown' }
  }
  // RLS filters out rows the user can't touch, which shows up as zero rows
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  await recordImpersonationAction(supabase, impersonation)
  revalidatePath(INBOX_PATH, 'page')
  return { ok: true }
}

export async function setConversationAutoReply(
  id: string,
  enabled: boolean
): Promise<ConversationActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!UUID_PATTERN.test(id)) return { ok: false, error: 'notFound' }

  const { data, error } = await supabase
    .from('conversations')
    .update({ auto_reply_enabled: enabled === true })
    .eq('id', id)
    .select('id')

  if (error) {
    console.error('[conversations] setConversationAutoReply', errorForLog(error))
    return { ok: false, error: 'unknown' }
  }
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  return { ok: true }
}

export async function assignConversation(
  id: string,
  userId: string | null
): Promise<ConversationActionResult> {
  // A support tool: allowed while a super admin views the account (and counted)
  const { supabase, profile, impersonation } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(id)) return { ok: false, error: 'notFound' }
  if (userId !== null && !UUID_PATTERN.test(userId)) return { ok: false, error: 'validation' }

  const { data: conversation } = await supabase
    .from('conversations')
    .select('client_id')
    .eq('id', id)
    .maybeSingle<{ client_id: string }>()
  if (!conversation) return { ok: false, error: 'notFound' }

  // Only people on the client's team can be assigned — anyone else wouldn't
  // be able to open the conversation
  if (userId) {
    const { data } = await supabase.rpc('client_team', { check_client_id: conversation.client_id })
    const team = data as TeamMember[] | null
    if (!team?.some((member) => member.id === userId)) return { ok: false, error: 'validation' }
  }

  const { data, error } = await supabase
    .from('conversations')
    .update({ assigned_to: userId })
    .eq('id', id)
    .select('id')

  if (error) {
    console.error('[conversations] assignConversation', errorForLog(error))
    return { ok: false, error: 'unknown' }
  }
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  await recordImpersonationAction(supabase, impersonation)
  revalidatePath(INBOX_PATH, 'page')
  return { ok: true }
}
