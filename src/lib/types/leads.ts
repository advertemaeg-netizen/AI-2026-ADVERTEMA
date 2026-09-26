import { z } from 'zod'
import type { ChannelType } from './channels'
import type { DateRange } from './conversations'

export const LEAD_STATUSES = [
  'new',
  'contacted',
  'appointment_booked',
  'showed_up',
  'no_show',
  'lost',
] as const
export type LeadStatus = (typeof LEAD_STATUSES)[number]

/** Statuses that still need work — used for the "active leads" stat */
export const ACTIVE_LEAD_STATUSES: LeadStatus[] = ['new', 'contacted', 'appointment_booked']

export type LeadFilters = {
  clientId?: string
  status?: LeadStatus
  channelType?: ChannelType
  range?: DateRange
  q?: string
}

export type LeadListItem = {
  id: string
  name: string | null
  phone: string | null
  service_requested: string | null
  status: LeadStatus
  created_at: string
  last_contacted_at: string | null
  follow_up_date: string | null
  confidence_score: number | null
  client: { id: string; name: string }
  conversation: { id: string; channel: { type: ChannelType; name: string } | null } | null
}

export type LeadExtractedData = {
  is_lead?: boolean
  confidence?: number
  name?: string | null
  phone?: string | null
  service_requested?: string | null
  budget?: string | null
  branch?: string | null
  preferred_time?: string | null
  summary?: string | null
  appointment_date?: string | null
  appointment_time?: string | null
  appointment_time_approximate?: boolean
  /** The resolved instant the AI stored in appointment_at, if any */
  appointment_at?: string | null
}

export type LeadDetail = LeadListItem & {
  appointment_at: string | null
  appointment_confirmed: boolean
  showed_up: boolean | null
  arrival_confirmed_at: string | null
  no_show_reason: string | null
  budget: string | null
  branch: string | null
  notes: string | null
  updated_at: string
  ai_extracted_data: LeadExtractedData | null
}

export type LeadEventType =
  | 'appointment_set'
  | 'appointment_confirmed'
  | 'created'
  | 'status_changed'
  | 'details_updated'
  | 'notes_updated'
  | 'follow_up_set'
  | 'contacted'

export type LeadEvent = {
  id: string
  event_type: LeadEventType
  from_value: string | null
  to_value: string | null
  actor_id: string | null
  created_at: string
}

const optionalText = (max: number) =>
  z
    .string()
    .trim()
    .max(max, 'tooLong')
    .transform((v) => (v === '' ? null : v))
    .nullable()

/** Fields a user may edit on a lead (all optional: partial updates). */
export const leadUpdateSchema = z
  .object({
    name: optionalText(120),
    phone: z
      .string()
      .trim()
      .max(30)
      .nullable()
      .transform((v) => (v ? v : null)),
    service_requested: optionalText(300),
    budget: optionalText(120),
    branch: optionalText(120),
    notes: optionalText(5000),
    status: z.enum(LEAD_STATUSES),
    follow_up_date: z.iso.datetime({ offset: true }).nullable(),
    last_contacted_at: z.iso.datetime({ offset: true }).nullable(),
  })
  .partial()

export type LeadUpdateInput = z.input<typeof leadUpdateSchema>

export type LeadActionResult =
  | { ok: true }
  | { ok: false; error: 'unauthorized' | 'forbidden' | 'notFound' | 'validation' | 'invalidPhone' | 'unknown' }
