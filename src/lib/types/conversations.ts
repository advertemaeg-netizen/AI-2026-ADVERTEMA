import type { ChannelType } from './channels'

export const CONVERSATION_STATUSES = ['new', 'in_progress', 'converted', 'closed'] as const
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number]

/**
 * Why a conversation waits for a person (conversations.needs_human_reason).
 * Each one asks something different of the client:
 * service_down — the AI call failed, ours to fix; limit_reached — upgrade the
 * plan; inactive — pay; no_answer — the knowledge base lacks the answer.
 */
export const NEEDS_HUMAN_REASONS = ['service_down', 'limit_reached', 'inactive', 'no_answer'] as const
export type NeedsHumanReason = (typeof NEEDS_HUMAN_REASONS)[number]

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
  auto_reply_enabled: boolean
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
