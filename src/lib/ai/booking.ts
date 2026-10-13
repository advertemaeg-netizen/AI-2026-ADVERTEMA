import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  confirmsItself,
  openingAt,
  resolveAppointment,
  sameInstant,
  type AppointmentRequest,
  type BookingOutcome,
} from '@/lib/ai/appointment'
import { MAX_PHONE_REJECTIONS, missingDetails, type ContactEvents, type ContactState } from '@/lib/ai/contact'
import type { SavedRecord } from '@/lib/ai/compose'
import { normalizePhone } from '@/lib/phone'
import type { BusinessHours } from '@/lib/types/bot-settings'
import { CLOSED_LEAD_STATUSES, type AiAppointment, type LeadExtractedData, type LeadStatus } from '@/lib/types/leads'

type BookableLead = {
  id: string
  name: string | null
  phone: string | null
  status: LeadStatus
  appointment_at: string | null
  appointment_confirmed: boolean
  showed_up: boolean | null
  ai_appointment: AiAppointment | null
  ai_extracted_data: LeadExtractedData | null
}

const COLUMNS = 'id, name, phone, status, appointment_at, appointment_confirmed, showed_up, ai_appointment, ai_extracted_data'

const isClosed = (lead: BookableLead) => CLOSED_LEAD_STATUSES.includes(lead.status)

async function loadLeads(supabase: SupabaseClient, conversationId: string) {
  const { data, error } = await supabase
    .from('leads')
    .select(COLUMNS)
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .returns<BookableLead[]>()
  if (error) throw error
  return data
}

/**
 * Writes the visitor's name and number, as code accepted them, on the
 * conversation's open lead, before the reply is rendered — and returns what
 * the lead row then holds, which is the only thing the reply may state as
 * saved. A valid phone number opens a lead when there is none: a number the
 * visitor was told nothing about must not be a number the clinic never got.
 *
 * The assistant fills an empty field, or replaces a value that is still its
 * own (the visitor corrected it); anything the team edited stays.
 * Throws on a database error.
 */
export async function saveContact({
  supabase,
  clientId,
  conversationId,
  sourceMessageId,
  contact,
  events,
}: {
  supabase: SupabaseClient
  clientId: string
  conversationId: string
  sourceMessageId: string | null
  contact: ContactState
  events: ContactEvents
}): Promise<SavedRecord> {
  const leads = await loadLeads(supabase, conversationId)
  let open = leads.find((lead) => !isClosed(lead)) ?? null
  const traced = { accepted_name: contact.name, accepted_phone: contact.phone, name_incomplete: contact.nameIncomplete }

  if (!open) {
    if (events.phone !== 'stored') return { name: null, phone: null }
    const returningFrom = leads.findLast(isClosed) ?? null
    const row = { name: contact.name ?? returningFrom?.name ?? null, phone: contact.phone }
    const { error } = await supabase.from('leads').insert({
      client_id: clientId,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
      ...row,
      status: 'new',
      ai_extracted_data: traced,
    })
    if (!error) return row
    // 23505: a concurrent message opened the lead first — write on that one
    if (error.code !== '23505') throw error
    open = (await loadLeads(supabase, conversationId)).find((lead) => !isClosed(lead)) ?? null
    if (!open) return { name: null, phone: null }
  }

  const previous = open.ai_extracted_data ?? {}
  const patch: Partial<SavedRecord> = {}
  for (const key of ['name', 'phone'] as const) {
    const value = contact[key]
    const current = open[key]
    // Rows from before E.164 hold the local form of the same number
    const same = key === 'phone' ? normalizePhone(current) === value : current === value
    const aiOwned = !current || current === (previous[`accepted_${key}`] ?? previous[key])
    if (value && !same && aiOwned) patch[key] = value
  }
  if (Object.keys(patch).length > 0) {
    const { error } = await supabase
      .from('leads')
      .update({ ...patch, ai_extracted_data: { ...previous, ...traced } })
      .eq('id', open.id)
    if (error) throw error
  }
  return { name: patch.name ?? open.name, phone: patch.phone ?? open.phone }
}

/**
 * Records the appointment the visitor asked for on the conversation's open
 * lead, before the reply is sent — the reply then quotes what this returns.
 *
 * Nothing becomes an appointment until it has passed the gate: a time the
 * resolver accepts (a real day and time, not gone, inside opening hours), a
 * name and a valid phone number. Short of the name or the number, the time
 * is kept on the lead as a request (ai_appointment.pending) and the outcome
 * is 'needs_details': no appointment_at, no status change, nothing to claim.
 * confirmPending() turns it into the appointment once the details are there.
 *
 * The assistant only sets or moves a time that is its own: one the team set,
 * confirmed by hand, or already marked attended/missed stays ('kept').
 * Throws on a database error: nothing was recorded, so nothing may be claimed.
 */
export async function recordAppointment({
  supabase,
  clientId,
  conversationId,
  sourceMessageId,
  request,
  autoConfirm,
  businessHours,
  source,
  contact,
  now = new Date(),
}: {
  supabase: SupabaseClient
  clientId: string
  conversationId: string
  sourceMessageId: string | null
  request: AppointmentRequest
  /** bot_settings.auto_confirm_appointments */
  autoConfirm: boolean
  /** Settles a bare hour ("at 9"), and refuses a time the business is closed at */
  businessHours: BusinessHours | null
  /**
   * 'reply': read by the reply call; opens a lead if there is none.
   * 'analysis': read by the analysis of a message the bot didn't answer; only
   * ever set on the lead that analysis found or created.
   */
  source: 'reply' | 'analysis'
  /** The name and number code has accepted in this conversation, for a lead opened here */
  contact: ContactState | null
  now?: Date
}): Promise<BookingOutcome> {
  const leads = await loadLeads(supabase, conversationId)
  let open = leads.find((lead) => !isClosed(lead)) ?? null

  // A time-only change ("make it 7") keeps the day already on record, or asked for
  const keepDayOf = open?.appointment_at ?? (open?.ai_appointment?.pending ? open.ai_appointment.at : null)
  const resolved = resolveAppointment(request, { now, keepDayOf, businessHours })
  if (resolved.status !== 'resolved') return resolved

  const returningFrom = leads.findLast(isClosed) ?? null
  const name = open?.name ?? contact?.name ?? returningFrom?.name ?? null
  const phone = open?.phone ?? contact?.phone ?? returningFrom?.phone ?? null
  const missing = missingDetails(name, phone)
  const confirmed = confirmsItself(autoConfirm, resolved.validated, request.needs_team_check === true)
  const aiAppointment: AiAppointment = {
    at: resolved.at,
    approximate: resolved.approximate,
    confirmed,
    source,
    ...(missing.length > 0 ? { pending: true as const } : {}),
  }
  const needsDetails: BookingOutcome = {
    status: 'needs_details',
    at: resolved.at,
    missing,
    handoff: missing.includes('phone') && (contact?.phoneRejections ?? 0) >= MAX_PHONE_REJECTIONS,
  }

  if (!open) {
    if (source === 'analysis') return { status: 'none' }
    const booked = missing.length === 0
    const { error } = await supabase.from('leads').insert({
      client_id: clientId,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
      name,
      phone,
      status: booked ? 'appointment_booked' : 'new',
      ...(booked ? { appointment_at: resolved.at, appointment_confirmed: confirmed } : {}),
      ai_appointment: aiAppointment,
    })
    if (!error) return booked ? { status: 'booked', at: resolved.at, confirmed, changed: true } : needsDetails
    // 23505: a concurrent message opened the lead first — book on that one
    if (error.code !== '23505') throw error
    open = (await loadLeads(supabase, conversationId)).find((lead) => !isClosed(lead)) ?? null
    if (!open) return { status: 'none' }
  }

  if (sameInstant(open.appointment_at, resolved.at)) {
    return { status: 'booked', at: open.appointment_at!, confirmed: open.appointment_confirmed, changed: false }
  }

  // Still the assistant's own: the time it set, not confirmed by anyone but
  // itself, and not yet attended or missed
  const aiOwned =
    !open.appointment_at ||
    (sameInstant(open.appointment_at, open.ai_appointment?.at) &&
      open.showed_up === null &&
      (!open.appointment_confirmed || open.ai_appointment?.confirmed === true))
  if (!aiOwned) return { status: 'kept', at: open.appointment_at! }

  if (missing.length > 0) {
    // Not an appointment: the lead keeps what was asked for, and nothing else changes
    if (!open.appointment_at) {
      const { error } = await supabase.from('leads').update({ ai_appointment: aiAppointment }).eq('id', open.id)
      if (error) throw error
    }
    return needsDetails
  }

  return writeAppointment(supabase, open, aiAppointment)
}

/** The appointment itself, on a lead that has passed the gate */
async function writeAppointment(supabase: SupabaseClient, lead: BookableLead, aiAppointment: AiAppointment): Promise<BookingOutcome> {
  const { error } = await supabase
    .from('leads')
    .update({
      appointment_at: aiAppointment.at,
      ai_appointment: aiAppointment,
      ...(lead.status === 'new' || lead.status === 'contacted' ? { status: 'appointment_booked' } : {}),
    })
    .eq('id', lead.id)
  if (error) throw error

  // A new time is unconfirmed again (sync_lead_attendance), so confirming it
  // is its own step
  if (aiAppointment.confirmed) {
    const { error: confirmError } = await supabase.from('leads').update({ appointment_confirmed: true }).eq('id', lead.id)
    if (confirmError) throw confirmError
  }
  return { status: 'booked', at: aiAppointment.at, confirmed: aiAppointment.confirmed, changed: true }
}

/**
 * The time the visitor asked for earlier, kept as a request while their name
 * or number was missing, becomes the appointment once both are on record —
 * on their next message, whatever it is about. The time is checked again as
 * it stands now: gone, or outside opening hours, it is dropped and said so.
 * Returns null when there is no such request, or the details are still short.
 * Throws on a database error.
 */
export async function confirmPending({
  supabase,
  conversationId,
  businessHours,
  now = new Date(),
}: {
  supabase: SupabaseClient
  conversationId: string
  businessHours: BusinessHours | null
  now?: Date
}): Promise<BookingOutcome | null> {
  const open = (await loadLeads(supabase, conversationId)).find((lead) => !isClosed(lead)) ?? null
  const pending = open?.ai_appointment
  if (!open || !pending?.pending || open.appointment_at) return null
  if (missingDetails(open.name, open.phone).length > 0) return null

  const drop = async (outcome: BookingOutcome) => {
    const { error } = await supabase.from('leads').update({ ai_appointment: null }).eq('id', open.id)
    if (error) throw error
    return outcome
  }
  if (new Date(pending.at).getTime() < now.getTime()) return drop({ status: 'past' })
  if (businessHours?.enabled) {
    const opening = openingAt(businessHours, pending.at)
    if (!opening.open) return drop({ status: 'outside_hours', hours: opening.day })
  }
  return writeAppointment(supabase, open, {
    at: pending.at,
    approximate: pending.approximate,
    confirmed: pending.confirmed,
    source: pending.source,
  })
}

/**
 * The appointment already on record for the conversation's open lead, as the
 * outcome of a message that didn't ask for one. For a reply that quotes the
 * appointment (the placeholder) without reporting it again: it is answered
 * from the record, not treated as a booking that never happened.
 * Throws on a database error.
 */
export async function appointmentOnRecord({
  supabase,
  conversationId,
}: {
  supabase: SupabaseClient
  conversationId: string
}): Promise<BookingOutcome> {
  const { data, error } = await supabase
    .from('leads')
    .select('status, appointment_at, appointment_confirmed')
    .eq('conversation_id', conversationId)
    .not('appointment_at', 'is', null)
    .order('created_at', { ascending: true })
    .returns<Pick<BookableLead, 'status' | 'appointment_at' | 'appointment_confirmed'>[]>()
  if (error) throw error
  const open = data.find((lead) => !CLOSED_LEAD_STATUSES.includes(lead.status))
  if (!open) return { status: 'none' }
  return { status: 'booked', at: open.appointment_at!, confirmed: open.appointment_confirmed, changed: false }
}

/** What the open lead holds: the only source for a statement about what is saved */
export async function savedRecord(supabase: SupabaseClient, conversationId: string): Promise<SavedRecord> {
  const open = (await loadLeads(supabase, conversationId)).find((lead) => !isClosed(lead)) ?? null
  return { name: open?.name ?? null, phone: open?.phone ?? null }
}
