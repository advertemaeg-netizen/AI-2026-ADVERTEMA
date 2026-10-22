import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  confirmsItself,
  openingAt,
  parseBookingDraft,
  resolveAppointment,
  resolveDay,
  sameInstant,
  type AppointmentRequest,
  type BookingDraft,
  type BookingOutcome,
} from '@/lib/ai/appointment'
import { MAX_PHONE_REJECTIONS, missingDetails, type ContactEvents, type ContactState } from '@/lib/ai/contact'
import { cairoParts } from '@/lib/cairo-time'
import type { BookingMode } from '@/lib/types/bot-settings'
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
  booking_draft: unknown
}

const COLUMNS = 'id, name, phone, status, appointment_at, appointment_confirmed, showed_up, ai_appointment, ai_extracted_data, booking_draft'

const isClosed = (lead: BookableLead) => CLOSED_LEAD_STATUSES.includes(lead.status)

/**
 * Whether the appointment on record was checked by anyone: code against the
 * opening hours, or a person who set or confirmed it. A time the assistant
 * set without hours to check it against is still a request.
 */
function checkedOnRecord(lead: Pick<BookableLead, 'appointment_at' | 'appointment_confirmed' | 'ai_appointment'>) {
  if (!sameInstant(lead.appointment_at, lead.ai_appointment?.at)) return true
  return lead.appointment_confirmed || lead.ai_appointment?.validated === true
}

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
 * THE LEAD IS WRITTEN AS IT ARRIVES. Whatever this message gave toward it —
 * the visitor's name or number as code accepted them, the partial booking
 * (the draft) — goes onto the conversation's open lead now, before the reply
 * is rendered and before anything is booked; the first of them opens the
 * lead. Every later piece updates that same row. Nothing waits for a complete
 * set, so a failure further on (the booking write, the reply) cannot take
 * back what was already given (the 20 October booking lost at confirmation).
 *
 * A row is a lead the client sees once it holds a name and a phone
 * (leads.is_complete, enforced by RLS); until then only a super admin does.
 *
 * Returns what the lead row then holds, which is the only thing the reply may
 * state as saved. The assistant fills an empty field, or replaces a value
 * that is still its own (the visitor corrected it); anything the team edited
 * stays. `draft`: the partial booking to store (null clears it); undefined
 * leaves it as it is. Throws on a database error.
 */
export async function saveContact({
  supabase,
  clientId,
  conversationId,
  sourceMessageId,
  contact,
  events,
  draft,
}: {
  supabase: SupabaseClient
  clientId: string
  conversationId: string
  sourceMessageId: string | null
  contact: ContactState
  /** What this message did to the name and number: only something it gave opens a lead */
  events: ContactEvents
  draft?: BookingDraft | null
}): Promise<SavedRecord> {
  const leads = await loadLeads(supabase, conversationId)
  let open = leads.find((lead) => !isClosed(lead)) ?? null
  const traced = { accepted_name: contact.name, accepted_phone: contact.phone, name_incomplete: contact.nameIncomplete }
  const draftPatch = draft === undefined ? {} : { booking_draft: draft }

  if (!open) {
    // A lead opens with something THIS message gave: a name or number carried
    // over from an earlier episode is not new (a customer who came back to
    // say thanks has not started another)
    const gave = events.name === 'stored' || events.name === 'stored_incomplete' || events.phone === 'stored' || Boolean(draft)
    if (!gave) return { name: null, phone: null }
    const returningFrom = leads.findLast(isClosed) ?? null
    const row = { name: contact.name ?? returningFrom?.name ?? null, phone: contact.phone ?? returningFrom?.phone ?? null }
    const { error } = await supabase.from('leads').insert({
      client_id: clientId,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
      ...row,
      ...draftPatch,
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
  if (Object.keys(patch).length > 0 || draft !== undefined) {
    const { error } = await supabase
      .from('leads')
      .update({ ...patch, ...draftPatch, ...(Object.keys(patch).length > 0 ? { ai_extracted_data: { ...previous, ...traced } } : {}) })
      .eq('id', open.id)
    if (error) throw error
  }
  return { name: patch.name ?? open.name, phone: patch.phone ?? open.phone }
}

/**
 * Where the conversation's open lead stands on a booking: a day (and time)
 * held for the visitor's details (confirmPending can book it on this
 * message), and the partial booking written so far. Throws on a database error.
 */
export async function bookingState(
  supabase: SupabaseClient,
  conversationId: string
): Promise<{ held: boolean; draft: BookingDraft | null; hasDraft: boolean }> {
  const open = (await loadLeads(supabase, conversationId)).find((lead) => !isClosed(lead)) ?? null
  return {
    held: Boolean(open?.ai_appointment?.pending && !open.appointment_at),
    draft: parseBookingDraft(open?.booking_draft),
    // A lead whose booking_draft was never written: rows from before it existed fall back to the message trace
    hasDraft: open !== null && open.booking_draft !== undefined && open.booking_draft !== null,
  }
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
  hourFromPartOfDay = true,
  mode = 'appointment',
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
  /** resolveAppointment's: false where the visitor can be asked for the hour (the reply) */
  hourFromPartOfDay?: boolean
  /** 'day_only': a day is booked, never a time (resolveDay); otherwise a day and a time */
  mode?: Exclude<BookingMode, 'none'>
  now?: Date
}): Promise<BookingOutcome> {
  const leads = await loadLeads(supabase, conversationId)
  let open = leads.find((lead) => !isClosed(lead)) ?? null

  const dayOnly = mode === 'day_only'
  // A time-only change ("make it 7") keeps the day already on record, or asked for
  const keepDayOf = open?.appointment_at ?? (open?.ai_appointment?.pending ? open.ai_appointment.at : null)
  const resolved = dayOnly
    ? resolveDay(request, { now, businessHours })
    : resolveAppointment(request, { now, keepDayOf, businessHours, hourFromPartOfDay })
  if (resolved.status !== 'resolved') return resolved

  const returningFrom = leads.findLast(isClosed) ?? null
  const name = open?.name ?? contact?.name ?? returningFrom?.name ?? null
  const phone = open?.phone ?? contact?.phone ?? returningFrom?.phone ?? null
  const missing = missingDetails(name, phone)
  const confirmed = confirmsItself(autoConfirm, resolved.validated)
  const aiAppointment: AiAppointment = {
    at: resolved.at,
    approximate: resolved.approximate,
    confirmed,
    validated: resolved.validated,
    source,
    ...(missing.length > 0 ? { pending: true as const } : {}),
    ...(request.needs_team_check === true ? { needs_team_check: true as const } : {}),
    // The day is the booking; the stored time only places it on that day
    ...(dayOnly ? { day_only: true as const } : {}),
  }
  const needsDetails: BookingOutcome = {
    status: 'needs_details',
    at: resolved.at,
    missing,
    handoff: missing.includes('phone') && (contact?.phoneRejections ?? 0) >= MAX_PHONE_REJECTIONS,
    validated: resolved.validated,
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
    if (!error) return booked ? { status: 'booked', at: resolved.at, confirmed, changed: true, validated: resolved.validated } : needsDetails
    // 23505: a concurrent message opened the lead first — book on that one
    if (error.code !== '23505') throw error
    open = (await loadLeads(supabase, conversationId)).find((lead) => !isClosed(lead)) ?? null
    if (!open) return { status: 'none' }
  }

  if (sameInstant(open.appointment_at, resolved.at)) {
    return { status: 'booked', at: open.appointment_at!, confirmed: open.appointment_confirmed, changed: false, validated: checkedOnRecord(open) }
  }

  // Still the assistant's own: the time it set, not confirmed by anyone but
  // itself, and not yet attended or missed
  const aiOwned =
    !open.appointment_at ||
    (sameInstant(open.appointment_at, open.ai_appointment?.at) &&
      open.showed_up === null &&
      (!open.appointment_confirmed || open.ai_appointment?.confirmed === true))
  if (!aiOwned) return { status: 'kept', at: open.appointment_at!, validated: checkedOnRecord(open) }

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
  return { status: 'booked', at: aiAppointment.at, confirmed: aiAppointment.confirmed, changed: true, validated: aiAppointment.validated === true }
}

/**
 * The time the visitor asked for earlier, kept as a request while their name
 * or number was missing, becomes the appointment once both are on record —
 * on their next message, whatever it is about. The time is checked again as
 * it stands now: gone, or outside opening hours, it is dropped and said so,
 * details or not. While the details are still short it stays held, and the
 * outcome is 'needs_details' with what is missing: code asks for the next one
 * itself (the name, then the number), not the model.
 * Returns null when there is no such request. Throws on a database error.
 */
export async function confirmPending({
  supabase,
  conversationId,
  businessHours,
  contact = null,
  now = new Date(),
}: {
  supabase: SupabaseClient
  conversationId: string
  businessHours: BusinessHours | null
  /** The name and number as code holds them after this message: whether the bot has stopped asking for the number */
  contact?: ContactState | null
  now?: Date
}): Promise<BookingOutcome | null> {
  const open = (await loadLeads(supabase, conversationId)).find((lead) => !isClosed(lead)) ?? null
  const pending = open?.ai_appointment
  if (!open || !pending?.pending || open.appointment_at) return null

  const drop = async (outcome: BookingOutcome) => {
    const { error } = await supabase.from('leads').update({ ai_appointment: null }).eq('id', open.id)
    if (error) throw error
    return outcome
  }
  // A day-only visit has gone when its day has, not its placing time
  const gone = pending.day_only ? dayKey(pending.at) < dayKey(now) : new Date(pending.at).getTime() < now.getTime()
  if (gone) return drop({ status: 'past' })
  if (businessHours?.enabled) {
    const opening = openingAt(businessHours, pending.at)
    if (!opening.open) return drop({ status: 'outside_hours', hours: opening.day })
  }
  // Checked again just now, against the hours as they stand
  const validated = businessHours?.enabled === true
  const missing = missingDetails(open.name, open.phone)
  if (missing.length > 0) {
    return {
      status: 'needs_details',
      at: pending.at,
      missing,
      handoff: missing.includes('phone') && (contact?.phoneRejections ?? 0) >= MAX_PHONE_REJECTIONS,
      validated,
    }
  }
  return writeAppointment(supabase, open, {
    at: pending.at,
    approximate: pending.approximate,
    confirmed: pending.confirmed,
    validated,
    source: pending.source,
    ...(pending.needs_team_check ? { needs_team_check: true as const } : {}),
    ...(pending.day_only ? { day_only: true as const } : {}),
  })
}

/** "2026-10-22": a Cairo calendar day, comparable as text */
function dayKey(at: string | Date) {
  const { year, month, day } = cairoParts(at)
  return `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/**
 * Whether the open lead holds a time asked for earlier that this message
 * could turn into the appointment (confirmPending): the model is told so
 * before it answers, because then code may decide about the appointment
 * without the model reporting one. Throws on a database error.
 */
export async function heldRequest(supabase: SupabaseClient, conversationId: string): Promise<boolean> {
  const open = (await loadLeads(supabase, conversationId)).find((lead) => !isClosed(lead)) ?? null
  return Boolean(open?.ai_appointment?.pending && !open.appointment_at)
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
    .select('status, appointment_at, appointment_confirmed, ai_appointment')
    .eq('conversation_id', conversationId)
    .not('appointment_at', 'is', null)
    .order('created_at', { ascending: true })
    .returns<Pick<BookableLead, 'status' | 'appointment_at' | 'appointment_confirmed' | 'ai_appointment'>[]>()
  if (error) throw error
  const open = data.find((lead) => !CLOSED_LEAD_STATUSES.includes(lead.status))
  if (!open) return { status: 'none' }
  return { status: 'booked', at: open.appointment_at!, confirmed: open.appointment_confirmed, changed: false, validated: checkedOnRecord(open) }
}

/** What the open lead holds: the only source for a statement about what is saved */
export async function savedRecord(supabase: SupabaseClient, conversationId: string): Promise<SavedRecord> {
  const open = (await loadLeads(supabase, conversationId)).find((lead) => !isClosed(lead)) ?? null
  return { name: open?.name ?? null, phone: open?.phone ?? null }
}
