'use server'

import { getTranslations } from 'next-intl/server'
import { getSession } from '@/lib/auth/session'
import { getClientContext } from '@/lib/auth/client-context'
import { isOrgAdmin } from '@/lib/auth/permissions'
import { MAX_RANGE_DAYS, previousRange } from '@/lib/analytics-range'
import { cairoDayStart } from '@/lib/cairo-time'
import { UUID_PATTERN } from '@/lib/types/clients'
import type { ChannelType } from '@/lib/types/channels'
import type { LeadStatus } from '@/lib/types/leads'
import type { AnalyticsData, AnalyticsRange, ClientPerformance, Kpis } from '@/lib/types/analytics'

type Supabase = Awaited<ReturnType<typeof getSession>>['supabase']

const DAY = 24 * 60 * 60 * 1000
const TOP_CLIENTS = 5

// Postgres bigint/numeric can arrive as strings
const num = (value: unknown) => (value === null || value === undefined ? null : Number(value))
const int = (value: unknown) => Number(value ?? 0)

function validPeriod(from: string, to: string) {
  const f = Date.parse(from)
  const t = Date.parse(to)
  return !Number.isNaN(f) && !Number.isNaN(t) && f < t && t - f <= MAX_RANGE_DAYS * DAY
}

async function rpcRows<T>(supabase: Supabase, fn: string, args: Record<string, unknown>): Promise<T[]> {
  const { data, error } = await supabase.rpc(fn, args)
  if (error) throw new Error(`${fn} failed: ${error.message}`)
  return (data as T[] | null) ?? []
}

/** KPIs for one period (counts, response time, journey) — RLS scoped. */
async function periodKpis(
  supabase: Supabase,
  clientId: string | null,
  from: string,
  to: string
): Promise<Kpis & { showedUp: number }> {
  const count = async (table: 'conversations' | 'leads') => {
    let query = supabase.from(table).select('id', { count: 'exact', head: true }).gte('created_at', from).lt('created_at', to)
    if (clientId) query = query.eq('client_id', clientId)
    const { count: n, error } = await query
    if (error) throw new Error(`Failed to count ${table}: ${error.message}`)
    return n ?? 0
  }

  const [conversations, leads, response, journey] = await Promise.all([
    count('conversations'),
    count('leads'),
    rpcRows<{ avg_seconds: unknown }>(supabase, 'get_response_time_stats', {
      p_client_id: clientId,
      p_from: from,
      p_to: to,
    }),
    rpcRows<{ booked_count: unknown; showed_up_count: unknown; no_show_count: unknown }>(
      supabase,
      'get_journey_stats',
      { p_client_id: clientId, p_from: from, p_to: to }
    ),
  ])

  const booked = journey.reduce((sum, row) => sum + int(row.booked_count), 0)
  const showedUp = journey.reduce((sum, row) => sum + int(row.showed_up_count), 0)
  const noShow = journey.reduce((sum, row) => sum + int(row.no_show_count), 0)

  return {
    conversations,
    leads,
    conversionRate: conversations > 0 ? leads / conversations : null,
    avgResponseSeconds: num(response[0]?.avg_seconds),
    booked,
    attendanceRate: showedUp + noShow > 0 ? showedUp / (showedUp + noShow) : null,
    showedUp,
  }
}

/**
 * Everything the analytics page shows, in one call. clientId null = all
 * clients the user can see; RLS scopes every query (team members count only
 * the conversations assigned to them).
 */
export async function getAnalytics(
  clientId: string | null,
  range: AnalyticsRange
): Promise<AnalyticsData | null> {
  const { supabase, profile } = await getSession()
  if (!profile) return null
  if (clientId !== null && !UUID_PATTERN.test(clientId)) return null
  if (!validPeriod(range.from, range.to)) return null
  if (range.granularity !== 'day' && range.granularity !== 'week') return null

  const { from, to, granularity } = range
  const previous = previousRange(from, to)
  const period = { p_client_id: clientId, p_from: from, p_to: to }
  const showTopClients = clientId === null && isOrgAdmin(profile.role)

  const [currentPeriod, before, conversationsSeries, leadsSeries, channels, peakHours, statuses, response, performance] =
    await Promise.all([
      periodKpis(supabase, clientId, from, to),
      periodKpis(supabase, clientId, previous.from, previous.to),
      rpcRows<{ bucket: string; conversations: unknown }>(supabase, 'get_conversations_over_time', {
        ...period,
        p_granularity: granularity,
      }),
      rpcRows<{ bucket: string; leads: unknown }>(supabase, 'get_leads_over_time', {
        ...period,
        p_granularity: granularity,
      }),
      rpcRows<{ channel: ChannelType; conversations: unknown }>(supabase, 'get_channel_distribution', period),
      rpcRows<{ hour: number; messages: unknown }>(supabase, 'get_peak_hours', period),
      rpcRows<{ status: LeadStatus; leads: unknown }>(supabase, 'get_lead_status_breakdown', period),
      rpcRows<{ responded: unknown; median_seconds: unknown; agent_responded: unknown; agent_avg_seconds: unknown }>(
        supabase,
        'get_response_time_stats',
        period
      ),
      showTopClients
        ? rpcRows<{
            client_id: string
            client_name: string
            conversations: unknown
            leads: unknown
            booked: unknown
            showed_up: unknown
            no_show: unknown
          }>(supabase, 'get_client_performance', { p_from: from, p_to: to })
        : Promise.resolve(null),
    ])

  const { showedUp, ...current } = currentPeriod
  const leadsByBucket = new Map(leadsSeries.map((row) => [row.bucket, int(row.leads)]))
  const topClients: ClientPerformance[] | null = performance
    ? performance
        .map((row) => {
          const conversations = int(row.conversations)
          const leads = int(row.leads)
          const showedUp = int(row.showed_up)
          const resolved = showedUp + int(row.no_show)
          return {
            clientId: row.client_id,
            clientName: row.client_name,
            conversations,
            leads,
            booked: int(row.booked),
            showedUp,
            conversionRate: conversations > 0 ? leads / conversations : null,
            attendanceRate: resolved > 0 ? showedUp / resolved : null,
          }
        })
        // Best = most leads, then most attended, then most conversations
        .sort((a, b) => b.leads - a.leads || b.showedUp - a.showedUp || b.conversations - a.conversations)
        .slice(0, TOP_CLIENTS)
    : null

  return {
    range,
    previous,
    kpis: { current, previous: before },
    series: conversationsSeries.map((row) => ({
      date: row.bucket,
      conversations: int(row.conversations),
      leads: leadsByBucket.get(row.bucket) ?? 0,
    })),
    channels: channels.map((row) => ({ channel: row.channel, conversations: int(row.conversations) })),
    peakHours: peakHours.map((row) => ({ hour: row.hour, messages: int(row.messages) })),
    leadStatuses: statuses.map((row) => ({ status: row.status, leads: int(row.leads) })),
    funnel: {
      conversations: current.conversations,
      leads: current.leads,
      booked: current.booked,
      showedUp,
    },
    response: {
      responded: int(response[0]?.responded),
      medianSeconds: num(response[0]?.median_seconds),
      agentResponded: int(response[0]?.agent_responded),
      agentAvgSeconds: num(response[0]?.agent_avg_seconds),
    },
    topClients,
  }
}

/** Conversations per Cairo day for the last `days` days (overview sparkline). */
export async function getConversationTrend(
  clientId: string | null,
  days = 7
): Promise<{ date: string; conversations: number }[]> {
  const { supabase, profile } = await getSession()
  if (!profile) return []
  if (clientId !== null && !UUID_PATTERN.test(clientId)) return []
  const rows = await rpcRows<{ bucket: string; conversations: unknown }>(supabase, 'get_conversations_over_time', {
    p_client_id: clientId,
    p_from: cairoDayStart(-(days - 1)).toISOString(),
    p_to: new Date().toISOString(),
    p_granularity: 'day',
  })
  return rows.map((row) => ({ date: row.bucket, conversations: int(row.conversations) }))
}

function csvCell(value: string | number | null | undefined) {
  if (value === null || value === undefined) return ''
  let text = String(value)
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}` // no spreadsheet formulas
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

/**
 * The analytics data as CSV (UTF-8 with BOM so Excel reads Arabic), one
 * section per chart. Uses the dashboard's selected client, like the page.
 */
export async function exportAnalyticsCSV(
  clientId: string | null,
  range: AnalyticsRange
): Promise<{ ok: true; csv: string } | { ok: false; error: 'unauthorized' | 'invalid' }> {
  const data = await getAnalytics(clientId, range)
  if (!data) return { ok: false, error: 'invalid' }

  const t = await getTranslations('analytics')
  const tChannels = await getTranslations('channels')
  const tLeads = await getTranslations('leads')
  const context = await getClientContext()
  const clientName = clientId ? context?.clients.find((c) => c.id === clientId)?.name : t('export.allClients')

  const lines: string[] = []
  const row = (...cells: (string | number | null | undefined)[]) => lines.push(cells.map(csvCell).join(','))
  const pct = (value: number | null) => (value === null ? '' : `${Math.round(value * 1000) / 10}%`)
  const { current, previous } = data.kpis

  row(t('title'), clientName)
  row(t('export.period'), `${data.range.fromDate} → ${data.range.toDate}`)
  row()
  row(t('export.kpis'), t('export.current'), t('export.previous'))
  row(t('kpis.conversations'), current.conversations, previous.conversations)
  row(t('kpis.leads'), current.leads, previous.leads)
  row(t('kpis.conversionRate'), pct(current.conversionRate), pct(previous.conversionRate))
  row(t('kpis.responseTime'), current.avgResponseSeconds ?? '', previous.avgResponseSeconds ?? '')
  row(t('kpis.booked'), current.booked, previous.booked)
  row(t('kpis.attendanceRate'), pct(current.attendanceRate), pct(previous.attendanceRate))
  row()
  row(t('charts.overTime.title'))
  row(t('export.date'), t('series.conversations'), t('series.leads'))
  for (const point of data.series) row(point.date, point.conversations, point.leads)
  row()
  row(t('charts.channels.title'))
  for (const c of data.channels) row(tChannels(`types.${c.channel}`), c.conversations)
  row()
  row(t('charts.peakHours.title'))
  row(t('export.hour'), t('series.messages'))
  for (const h of data.peakHours) row(`${String(h.hour).padStart(2, '0')}:00`, h.messages)
  row()
  row(t('charts.leadStatus.title'))
  for (const s of data.leadStatuses) row(tLeads(`status.${s.status}`), s.leads)
  if (data.topClients) {
    row()
    row(t('topClients.title'))
    row(t('topClients.client'), t('series.conversations'), t('series.leads'), t('kpis.conversionRate'), t('kpis.booked'), t('kpis.attendanceRate'))
    for (const c of data.topClients) {
      row(c.clientName, c.conversations, c.leads, pct(c.conversionRate), c.booked, pct(c.attendanceRate))
    }
  }

  return { ok: true, csv: '﻿' + lines.join('\r\n') }
}

