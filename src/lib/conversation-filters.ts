import { UUID_PATTERN } from '@/lib/types/clients'
import { CHANNEL_TYPES } from '@/lib/types/channels'
import {
  CONVERSATION_STATUSES,
  DATE_RANGES,
  type ConversationFilters,
  type ConversationStatus,
} from '@/lib/types/conversations'

/** Normalizes raw URL search params into validated filters. */
export function parseConversationFilters(
  params: Record<string, string | string[] | undefined>
): ConversationFilters {
  const one = (key: string) => {
    const value = params[key]
    return typeof value === 'string' ? value : undefined
  }
  const clientId = one('client')
  const status = one('status')
  const channelType = one('channel')
  const range = one('range')
  const q = one('q')

  return {
    clientId: clientId && UUID_PATTERN.test(clientId) ? clientId : undefined,
    status: (CONVERSATION_STATUSES as readonly string[]).includes(status ?? '')
      ? (status as ConversationStatus)
      : undefined,
    channelType: (CHANNEL_TYPES as readonly string[]).includes(channelType ?? '')
      ? (channelType as ConversationFilters['channelType'])
      : undefined,
    range: (DATE_RANGES as readonly string[]).includes(range ?? '')
      ? (range as ConversationFilters['range'])
      : undefined,
    q: q?.trim() ? q.trim().slice(0, 100) : undefined,
  }
}
