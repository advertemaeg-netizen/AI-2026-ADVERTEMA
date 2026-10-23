import { cairoParts } from '@/lib/cairo-time'
import type { LeadStatus } from './leads'

export const APPOINTMENT_RANGES = ['today', 'tomorrow', 'week', 'all'] as const
export type AppointmentRange = (typeof APPOINTMENT_RANGES)[number]

export const JOURNEY_PERIODS = ['7d', '30d', '90d'] as const
export type JourneyPeriod = (typeof JOURNEY_PERIODS)[number]

export type Appointment = {
  id: string
  name: string | null
  phone: string | null
  service_requested: string | null
  status: LeadStatus
  appointment_at: string
  appointment_confirmed: boolean
  showed_up: boolean | null
  arrival_confirmed_at: string | null
  no_show_reason: string | null
  /** Read for one thing: whether the visit is a day-only one (isDayOnlyVisit) */
  ai_appointment: DayOnlyMark['ai_appointment']
  client: { id: string; name: string }
}

type DayOnlyMark = { ai_appointment?: { at: string; day_only?: true; validated?: boolean } | null }

/**
 * A day-only visit (first come, first served): the DAY is the booking, and
 * appointment_at only places it on that day. Nothing may show its time: a
 * clinic that reads "1:00 PM" tells a patient to come at one. Once the team
 * sets a time of their own (appointment_at moves), it is an ordinary
 * appointment again.
 */
export function isDayOnlyVisit(visit: { appointment_at: string | null } & DayOnlyMark): boolean {
  const ai = visit.ai_appointment
  return Boolean(ai?.day_only && visit.appointment_at && new Date(ai.at).getTime() === new Date(visit.appointment_at).getTime())
}

/**
 * What an appointment looks like right now, for its badge and actions.
 * request: a day-only visit nobody has checked (no opening hours to check its
 * day against, and no one on the team confirmed it). The visitor was told it
 * is a request and that the team will call, so it is never shown as booked.
 */
export type AppointmentState = 'upcoming' | 'today' | 'request' | 'late' | 'attended' | 'noShow'

export function appointmentState(
  appointment: Pick<Appointment, 'appointment_at' | 'showed_up' | 'appointment_confirmed'> & DayOnlyMark,
  now: Date = new Date()
): AppointmentState {
  if (appointment.showed_up === true) return 'attended'
  if (appointment.showed_up === false) return 'noShow'
  const day = cairoParts(appointment.appointment_at).dateKey
  const today = cairoParts(now).dateKey
  // A day-only visit is late only once its day has gone, never at its placing time
  if (isDayOnlyVisit(appointment)) {
    if (day < today) return 'late'
    if (!appointment.ai_appointment?.validated && !appointment.appointment_confirmed) return 'request'
    return day === today ? 'today' : 'upcoming'
  }
  if (new Date(appointment.appointment_at) < now) return 'late'
  return day === today ? 'today' : 'upcoming'
}

export type JourneyStats = {
  leads: number
  booked: number
  showedUp: number
  noShow: number
  /** showed up ÷ (showed up + no-show); null until an appointment is resolved */
  attendanceRate: number | null
}

export type AppointmentActionResult =
  // leadId: the appointment went to another lead (a new visit was opened)
  | { ok: true; leadId?: string }
  | { ok: false; error: 'unauthorized' | 'notFound' | 'validation' | 'impersonating' | 'unknown' }
