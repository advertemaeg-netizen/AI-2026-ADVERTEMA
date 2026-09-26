'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession } from '@/lib/auth/session'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  CONVERSATION_STATUSES,
  DATE_RANGES,
  type ConversationActionResult,
  type ConversationDetail,
  type ConversationFilters,
  type ConversationListItem,
  type ConversationStatus,
  type Message,
  type TeamMember,
} from '@/lib/types/conversations'

const INBOX_PATH = '/[locale]/dashboard/conversations'
const LIST_LIMIT = 100
const MAX_MESSAGE_LENGTH = 4000

const LIST_COLUMNS = `
  id, status, contact_name, contact_identifier, last_message_at,
  last_message_preview, last_message_role, assigned_to,
  client:clients!inner(id, name),
  channel:channels!inner(id, type, name)
`

const DETAIL_COLUMNS = `
  id, status, contact_name, contact_identifier, last_message_at,
  last_message_preview, last_message_role, assigned_to, created_at,
  client:clients!inner(id, name, industry, status),
  channel:channels!inner(id, type, name)
`

const MESSAGE_COLUMNS = 'id, conversation_id, role, content, sender_id, created_at'

const RANGE_DAYS: Record<(typeof DATE_RANGES)[number], number> = { today: 0, '7d': 7, '30d': 30 }

function rangeStart(range: (typeof DATE_RANGES)[number]) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - RANGE_DAYS[range])
  return start.toISOString()
}

// PostgREST `or()` filters are comma/paren delimited and ilike treats % and _
// as wildcards, so strip anything that could change the filter's meaning
function searchTerm(q: string) {
  return q.replace(/[,()%_\\*:"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
}

export async function getConversations(
  filters: ConversationFilters = {}
): Promise<ConversationListItem[]> {
  const { supabase, profile } = await getSession()
  if (!profile) return []

  let query = supabase
    .from('conversations')
    .select(LIST_COLUMNS)
    .order('last_message_at', { ascending: false })
    .limit(LIST_LIMIT)

  // RLS already enforces this; kept explicit so the intent is visible here
  if (!canManage(profile)) query = query.eq('assigned_to', profile.id)

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
  if (error) throw new Error(`Failed to load conversations: ${error.message}`)
  return data
}

export async function getConversation(id: string): Promise<{
  conversation: ConversationDetail
  messages: Message[]
  team: TeamMember[]
} | null> {
  if (!UUID_PATTERN.test(id)) return null
  const { supabase, profile } = await getSession()
  if (!profile) return null

  const { data: conversation, error } = await supabase
    .from('conversations')
    .select(DETAIL_COLUMNS)
    .eq('id', id)
    .maybeSingle<ConversationDetail>()

  if (error) throw new Error(`Failed to load conversation: ${error.message}`)
  if (!conversation) return null

  const [messagesResult, teamResult] = await Promise.all([
    supabase
      .from('messages')
      .select(MESSAGE_COLUMNS)
      .eq('conversation_id', id)
      .order('created_at', { ascending: true })
      .returns<Message[]>(),
    supabase.rpc('client_team', { check_client_id: conversation.client.id }),
  ])

  if (messagesResult.error) {
    throw new Error(`Failed to load messages: ${messagesResult.error.message}`)
  }
  if (teamResult.error) console.error('[conversations] client_team', teamResult.error)

  return {
    conversation,
    messages: messagesResult.data,
    team: (teamResult.data as TeamMember[] | null) ?? [],
  }
}

export async function sendAgentMessage(
  conversationId: string,
  content: string
): Promise<ConversationActionResult<Message>> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!UUID_PATTERN.test(conversationId)) return { ok: false, error: 'notFound' }

  const text = content.trim()
  if (!text || text.length > MAX_MESSAGE_LENGTH) return { ok: false, error: 'validation' }

  // RLS only allows role='agent' + sender_id = current user, and only on
  // conversations this user can see
  const { data: message, error } = await supabase
    .from('messages')
    .insert({ conversation_id: conversationId, role: 'agent', content: text, sender_id: profile.id })
    .select(MESSAGE_COLUMNS)
    .single<Message>()

  if (error) {
    if (error.code === '42501') return { ok: false, error: 'notFound' }
    console.error('[conversations] sendAgentMessage', error)
    return { ok: false, error: 'unknown' }
  }

  // A human replying means the conversation is being worked on
  await supabase
    .from('conversations')
    .update({ status: 'in_progress' })
    .eq('id', conversationId)
    .eq('status', 'new')

  revalidatePath(INBOX_PATH, 'page')
  return { ok: true, data: message }
}

export async function updateConversationStatus(
  id: string,
  status: ConversationStatus
): Promise<ConversationActionResult> {
  const { supabase, profile } = await getSession()
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
    console.error('[conversations] updateConversationStatus', error)
    return { ok: false, error: 'unknown' }
  }
  // RLS filters out rows the user can't touch, which shows up as zero rows
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(INBOX_PATH, 'page')
  return { ok: true }
}

export async function assignConversation(
  id: string,
  userId: string | null
): Promise<ConversationActionResult> {
  const { supabase, profile } = await getSession()
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
    console.error('[conversations] assignConversation', error)
    return { ok: false, error: 'unknown' }
  }
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(INBOX_PATH, 'page')
  return { ok: true }
}
