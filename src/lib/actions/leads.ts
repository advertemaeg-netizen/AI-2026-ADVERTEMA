'use server'

import { revalidatePath } from 'next/cache'
import { getTranslations } from 'next-intl/server'
import { canManage, getSession } from '@/lib/auth/session'
import { rangeStart, searchTerm } from '@/lib/list-filters'
import { normalizeEgyptianPhone } from '@/lib/phone'
import { UUID_PATTERN } from '@/lib/types/clients'
import type { TeamMember } from '@/lib/types/conversations'
import {
  LEAD_STATUSES,
  leadUpdateSchema,
  type LeadActionResult,
  type LeadDetail,
  type LeadEvent,
  type LeadFilters,
  type LeadListItem,
  type LeadStatus,
  type LeadUpdateInput,
} from '@/lib/types/leads'

const LEADS_PATH = '/[locale]/dashboard/leads'
const LIST_LIMIT = 200
const EXPORT_LIMIT = 5000
const BULK_LIMIT = 500
const EXPORT_TIMEZONE = 'Africa/Cairo'

const LIST_COLUMNS = `
  id, name, phone, service_requested, status, created_at, last_contacted_at,
  follow_up_date, confidence_score,
  client:clients!inner(id, name)`

// The channel filter needs inner joins, otherwise leads without a matching
// channel would still be returned (with a null embed)
function conversationEmbed(filterByChannel: boolean) {
  return filterByChannel
    ? 'conversation:conversations!inner(id, channel:channels!inner(type, name))'
    : 'conversation:conversations(id, channel:channels(type, name))'
}

type Supabase = Awaited<ReturnType<typeof getSession>>['supabase']

function leadsQuery(supabase: Supabase, columns: string, filters: LeadFilters) {
  let query = supabase
    .from('leads')
    .select(`${columns}, ${conversationEmbed(!!filters.channelType)}`)
    .order('created_at', { ascending: false })

  if (filters.clientId) query = query.eq('client_id', filters.clientId)
  if (filters.status) query = query.eq('status', filters.status)
  if (filters.channelType) query = query.eq('conversation.channel.type', filters.channelType)
  if (filters.range) query = query.gte('created_at', rangeStart(filters.range))

  const term = filters.q ? searchTerm(filters.q) : ''
  if (term) {
    // Also match phones typed with spaces, +20 or Arabic digits
    const phone = normalizeEgyptianPhone(term)
    const phoneTerm = phone ?? term.replace(/\s/g, '')
    query = query.or(
      `name.ilike.%${term}%,phone.ilike.%${phoneTerm}%,service_requested.ilike.%${term}%`
    )
  }
  return query
}

export async function getLeads(filters: LeadFilters = {}): Promise<LeadListItem[]> {
  const { supabase, profile } = await getSession()
  if (!profile) return []

  // RLS limits rows to leads of clients the user has access to
  const { data, error } = await leadsQuery(supabase, LIST_COLUMNS, filters)
    .limit(LIST_LIMIT)
    .returns<LeadListItem[]>()
  if (error) throw new Error(`Failed to load leads: ${error.message}`)
  return data
}

export async function getLead(id: string): Promise<{
  lead: LeadDetail
  events: LeadEvent[]
  team: TeamMember[]
} | null> {
  if (!UUID_PATTERN.test(id)) return null
  const { supabase, profile } = await getSession()
  if (!profile) return null

  const { data: lead, error } = await supabase
    .from('leads')
    .select(
      `${LIST_COLUMNS}, budget, branch, notes, updated_at, ai_extracted_data, appointment_at,
       appointment_confirmed, showed_up, arrival_confirmed_at, no_show_reason, ${conversationEmbed(false)}`
    )
    .eq('id', id)
    .maybeSingle<LeadDetail>()
  if (error) throw new Error(`Failed to load lead: ${error.message}`)
  if (!lead) return null

  const [eventsResult, teamResult] = await Promise.all([
    supabase
      .from('lead_events')
      .select('id, event_type, from_value, to_value, actor_id, created_at')
      .eq('lead_id', id)
      .order('created_at', { ascending: false })
      .limit(100)
      .returns<LeadEvent[]>(),
    // Names for the timeline (users RLS hides colleagues from non-admins)
    supabase.rpc('client_team', { check_client_id: lead.client.id }),
  ])
  if (eventsResult.error) console.error('[leads] events', eventsResult.error)

  return {
    lead,
    events: eventsResult.data ?? [],
    team: (teamResult.data as TeamMember[] | null) ?? [],
  }
}

export async function updateLead(id: string, data: LeadUpdateInput): Promise<LeadActionResult> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!UUID_PATTERN.test(id)) return { ok: false, error: 'notFound' }

  const parsed = leadUpdateSchema.safeParse(data)
  if (!parsed.success) return { ok: false, error: 'validation' }

  const patch = { ...parsed.data }
  if (patch.phone) {
    const phone = normalizeEgyptianPhone(patch.phone)
    if (!phone) return { ok: false, error: 'invalidPhone' }
    patch.phone = phone
  }
  if (Object.keys(patch).length === 0) return { ok: true }

  // RLS: anyone with access to the lead's client may work on it
  const { data: rows, error } = await supabase.from('leads').update(patch).eq('id', id).select('id')
  if (error) {
    console.error('[leads] update', error)
    return { ok: false, error: 'unknown' }
  }
  if (!rows || rows.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(LEADS_PATH, 'page')
  revalidatePath(`${LEADS_PATH}/[id]`, 'page')
  return { ok: true }
}

export async function bulkUpdateLeadStatus(
  ids: string[],
  status: LeadStatus
): Promise<LeadActionResult & { updated?: number }> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!(LEAD_STATUSES as readonly string[]).includes(status)) return { ok: false, error: 'validation' }
  if (
    !Array.isArray(ids) ||
    ids.length === 0 ||
    ids.length > BULK_LIMIT ||
    !ids.every((id) => typeof id === 'string' && UUID_PATTERN.test(id))
  ) {
    return { ok: false, error: 'validation' }
  }

  const { data, error } = await supabase.from('leads').update({ status }).in('id', ids).select('id')
  if (error) {
    console.error('[leads] bulk update', error)
    return { ok: false, error: 'unknown' }
  }

  revalidatePath(LEADS_PATH, 'page')
  return { ok: true, updated: data?.length ?? 0 }
}

export async function deleteLead(id: string): Promise<LeadActionResult> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  // RLS would allow any member of the client; deleting is kept to admins
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(id)) return { ok: false, error: 'notFound' }

  const { data, error } = await supabase.from('leads').delete().eq('id', id).select('id')
  if (error) {
    console.error('[leads] delete', error)
    return { ok: false, error: 'unknown' }
  }
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(LEADS_PATH, 'page')
  return { ok: true }
}

function csvCell(value: string | number | null | undefined) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  // Neutralize spreadsheet formulas (CSV injection)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * CSV of the leads matching `filters`, with a UTF-8 BOM so Excel reads Arabic
 * correctly. Headers and statuses follow the current locale.
 */
export async function exportLeads(filters: LeadFilters = {}): Promise<{ ok: true; csv: string } | { ok: false; error: 'unauthorized' | 'unknown' }> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }

  const { data, error } = await leadsQuery(
    supabase,
    `${LIST_COLUMNS}, budget, branch, notes`,
    filters
  )
    .limit(EXPORT_LIMIT)
    .returns<(LeadDetail & { notes: string | null })[]>()
  if (error) {
    console.error('[leads] export', error)
    return { ok: false, error: 'unknown' }
  }

  const t = await getTranslations('leads')
  const tChannels = await getTranslations('channels')
  // "2026-09-26 19:30" in Cairo time (sv-SE formats as ISO-like date + time)
  const formatDate = new Intl.DateTimeFormat('sv-SE', {
    timeZone: EXPORT_TIMEZONE,
    dateStyle: 'short',
    timeStyle: 'short',
  })
  const date = (value: string | null) => (value ? formatDate.format(new Date(value)) : '')

  const header = [
    t('fields.name'),
    t('fields.phone'),
    t('fields.service'),
    t('fields.budget'),
    t('fields.branch'),
    t('fields.client'),
    t('fields.channel'),
    t('fields.status'),
    t('fields.createdAt'),
    t('fields.lastContacted'),
    t('fields.followUp'),
    t('fields.confidence'),
    t('fields.notes'),
  ]

  const rows = data.map((lead) =>
    [
      csvCell(lead.name),
      // ="0101…" keeps Excel from dropping the leading zero
      lead.phone ? `="${lead.phone}"` : '',
      csvCell(lead.service_requested),
      csvCell(lead.budget),
      csvCell(lead.branch),
      csvCell(lead.client.name),
      csvCell(lead.conversation?.channel ? tChannels(`types.${lead.conversation.channel.type}`) : ''),
      csvCell(t(`status.${lead.status}`)),
      csvCell(date(lead.created_at)),
      csvCell(date(lead.last_contacted_at)),
      csvCell(date(lead.follow_up_date)),
      csvCell(lead.confidence_score !== null ? Math.round(lead.confidence_score * 100) + '%' : ''),
      csvCell(lead.notes),
    ].join(',')
  )

  return { ok: true, csv: '﻿' + [header.map(csvCell).join(','), ...rows].join('\r\n') }
}
