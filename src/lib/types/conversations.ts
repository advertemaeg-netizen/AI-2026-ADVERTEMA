import type { ChannelType } from './channels'

export const CONVERSATION_STATUSES = ['new', 'in_progress', 'converted', 'closed'] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

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
  client: { id: string; name: string }
  channel: { id: string; type: ChannelType; name: string }
}

export type Message = {
  id: string
  conversation_id: string
  role: MessageRole
  content: string
  sender_id: string | null
  created_at: string
}

export type TeamMember = {
  id: string
  full_name: string | null
  email: string
  role: string
}

export type ConversationDetail = ConversationListItem & {
  created_at: string
  client: { id: string; name: string; industry: string | null; status: string }
}

export type ConversationActionError =
  | 'unauthorized'
  | 'forbidden'
  | 'validation'
  | 'notFound'
  | 'unknown'

export type ConversationActionResult<T = undefined> =
  | (T extends undefined ? { ok: true } : { ok: true; data: T })
  | { ok: false; error: ConversationActionError }
