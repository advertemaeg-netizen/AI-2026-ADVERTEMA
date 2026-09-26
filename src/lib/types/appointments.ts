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
  client: { id: string; name: string }
}

/** What an appointment looks like right now, for its badge and actions. */
export type AppointmentState = 'upcoming' | 'today' | 'late' | 'attended' | 'noShow'

export function appointmentState(
  appointment: Pick<Appointment, 'appointment_at' | 'showed_up'>,
  now: Date = new Date()
): AppointmentState {
  if (appointment.showed_up === true) return 'attended'
  if (appointment.showed_up === false) return 'noShow'
  if (new Date(appointment.appointment_at) < now) return 'late'
  return cairoParts(appointment.appointment_at).dateKey === cairoParts(now).dateKey ? 'today' : 'upcoming'
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
  | { ok: true }
  | { ok: false; error: 'unauthorized' | 'notFound' | 'validation' | 'unknown' }
