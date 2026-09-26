'use server'

import { revalidatePath } from 'next/cache'
import { getSession } from '@/lib/auth/session'
import { cairoDayStart } from '@/lib/cairo-time'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  APPOINTMENT_RANGES,
  JOURNEY_PERIODS,
  type Appointment,
  type AppointmentActionResult,
  type AppointmentRange,
  type JourneyPeriod,
  type JourneyStats,
} from '@/lib/types/appointments'

const APPOINTMENT_COLUMNS = `
  id, name, phone, service_requested, status, appointment_at, appointment_confirmed,
  showed_up, arrival_confirmed_at, no_show_reason, client:clients!inner(id, name)`

const LIST_LIMIT = 300
const PERIOD_DAYS: Record<JourneyPeriod, number> = { '7d': 7, '30d': 30, '90d': 90 }
const DAY = 24 * 60 * 60 * 1000

/** [from, to) in Cairo days for each tab; "all" also shows the last 30 days */
function rangeBounds(range: AppointmentRange): { from: Date; to: Date | null } {
  switch (range) {
    case 'today':
      return { from: cairoDayStart(0), to: cairoDayStart(1) }
    case 'tomorrow':
      return { from: cairoDayStart(1), to: cairoDayStart(2) }
    case 'week':
      return { from: cairoDayStart(0), to: cairoDayStart(7) }
    case 'all':
      return { from: cairoDayStart(-30), to: null }
  }
}

export async function getUpcomingAppointments(
  filters: { range?: AppointmentRange; clientId?: string | null } = {}
): Promise<Appointment[]> {
  const { supabase, profile } = await getSession()
  if (!profile) return []

  const range = APPOINTMENT_RANGES.includes(filters.range as AppointmentRange)
    ? (filters.range as AppointmentRange)
    : 'today'
  const { from, to } = rangeBounds(range)

  // RLS limits rows to leads of clients the user can access
  let query = supabase
    .from('leads')
    .select(APPOINTMENT_COLUMNS)
    .gte('appointment_at', from.toISOString())
    .order('appointment_at', { ascending: true })
    .limit(LIST_LIMIT)
  if (to) query = query.lt('appointment_at', to.toISOString())
  if (filters.clientId && UUID_PATTERN.test(filters.clientId)) query = query.eq('client_id', filters.clientId)

  const { data, error } = await query.returns<Appointment[]>()
  if (error) throw new Error(`Failed to load appointments: ${error.message}`)
  return data
}

async function updateLeadRow(leadId: string, patch: Record<string, unknown>): Promise<AppointmentActionResult> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!UUID_PATTERN.test(leadId)) return { ok: false, error: 'notFound' }

  const { data, error } = await supabase.from('leads').update(patch).eq('id', leadId).select('id')
  if (error) {
    console.error('[appointments] update', error)
    return { ok: false, error: 'unknown' }
  }
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath('/[locale]/dashboard/appointments', 'page')
  revalidatePath('/[locale]/dashboard/leads/[id]', 'page')
  revalidatePath('/[locale]/dashboard', 'page')
  return { ok: true }
}

/** Sets (or clears, with null) the appointment time. New leads move to "appointment booked". */
export async function setAppointment(leadId: string, datetime: string | null): Promise<AppointmentActionResult> {
  if (datetime !== null && Number.isNaN(Date.parse(datetime))) return { ok: false, error: 'validation' }

  const { supabase } = await getSession()
  const { data: lead } = await supabase.from('leads').select('status').eq('id', leadId).maybeSingle<{ status: string }>()
  if (!lead) return { ok: false, error: 'notFound' }

  // Rescheduling after a visit/no-show is handled by the sync trigger
  return updateLeadRow(leadId, {
    appointment_at: datetime ? new Date(datetime).toISOString() : null,
    ...(datetime && (lead.status === 'new' || lead.status === 'contacted') ? { status: 'appointment_booked' } : {}),
  })
}

export async function setAppointmentConfirmed(leadId: string, confirmed: boolean): Promise<AppointmentActionResult> {
  return updateLeadRow(leadId, { appointment_confirmed: confirmed === true })
}

export async function confirmArrival(leadId: string): Promise<AppointmentActionResult> {
  return updateLeadRow(leadId, {
    status: 'showed_up',
    showed_up: true,
    arrival_confirmed_at: new Date().toISOString(),
    no_show_reason: null,
  })
}

export async function markNoShow(leadId: string, reason?: string | null): Promise<AppointmentActionResult> {
  const text = typeof reason === 'string' ? reason.trim().slice(0, 500) : ''
  return updateLeadRow(leadId, {
    status: 'no_show',
    showed_up: false,
    arrival_confirmed_at: null,
    no_show_reason: text || null,
  })
}

type JourneyRow = {
  leads_count: number
  booked_count: number
  showed_up_count: number
  no_show_count: number
}

function sumJourney(rows: JourneyRow[]): JourneyStats {
  const sum = (key: keyof JourneyRow) => rows.reduce((total, row) => total + Number(row[key] ?? 0), 0)
  const showedUp = sum('showed_up_count')
  const noShow = sum('no_show_count')
  return {
    leads: sum('leads_count'),
    booked: sum('booked_count'),
    showedUp,
    noShow,
    attendanceRate: showedUp + noShow > 0 ? showedUp / (showedUp + noShow) : null,
  }
}

/**
 * Journey funnel for leads created in the period (all visible clients when
 * clientId is null), plus the same for the period before, for comparison.
 */
export async function getJourneyStats(
  clientId: string | null,
  period: JourneyPeriod = '30d'
): Promise<{ current: JourneyStats; previous: JourneyStats } | null> {
  const { supabase, profile } = await getSession()
  if (!profile) return null
  if (clientId !== null && !UUID_PATTERN.test(clientId)) return null
  const days = PERIOD_DAYS[JOURNEY_PERIODS.includes(period) ? period : '30d']

  const now = Date.now()
  const call = (from: number, to: number) =>
    supabase.rpc('get_journey_stats', {
      p_client_id: clientId,
      p_from: new Date(from).toISOString(),
      p_to: new Date(to).toISOString(),
    })

  const [current, previous] = await Promise.all([
    call(now - days * DAY, now),
    call(now - 2 * days * DAY, now - days * DAY),
  ])
  if (current.error) throw new Error(`Failed to load journey stats: ${current.error.message}`)

  return {
    current: sumJourney((current.data as JourneyRow[] | null) ?? []),
    previous: sumJourney((previous.data as JourneyRow[] | null) ?? []),
  }
}
