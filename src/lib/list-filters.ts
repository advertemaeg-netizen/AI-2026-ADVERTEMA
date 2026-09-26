import { UUID_PATTERN } from '@/lib/types/clients'
import { CHANNEL_TYPES, type ChannelType } from '@/lib/types/channels'
import { DATE_RANGES, type DateRange } from '@/lib/types/conversations'

/** URL-driven filters shared by list pages (inbox, leads). */
export type ListFilters<S extends string> = {
  clientId?: string
  status?: S
  channelType?: ChannelType
  range?: DateRange
  q?: string
}

/** Normalizes raw URL search params into validated filters. */
export function parseListFilters<S extends string>(
  params: Record<string, string | string[] | undefined>,
  statuses: readonly S[]
): ListFilters<S> {
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
    status: (statuses as readonly string[]).includes(status ?? '') ? (status as S) : undefined,
    channelType: (CHANNEL_TYPES as readonly string[]).includes(channelType ?? '')
      ? (channelType as ChannelType)
      : undefined,
    range: (DATE_RANGES as readonly string[]).includes(range ?? '') ? (range as DateRange) : undefined,
    q: q?.trim() ? q.trim().slice(0, 100) : undefined,
  }
}

const RANGE_DAYS: Record<DateRange, number> = { today: 0, '7d': 7, '30d': 30 }

/** ISO start of a date-range filter (midnight, server time). */
export function rangeStart(range: DateRange) {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  start.setDate(start.getDate() - RANGE_DAYS[range])
  return start.toISOString()
}

// PostgREST `or()` filters are comma/paren delimited and ilike treats % and _
// as wildcards, so strip anything that could change the filter's meaning
export function searchTerm(q: string) {
  return q.replace(/[,()%_\\*:"']/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 100)
}
