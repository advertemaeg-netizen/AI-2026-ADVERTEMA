import 'server-only'
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  confirmsItself,
  parseBookingDraft,
  refusalAt,
  resolveAppointment,
  resolveDay,
  sameInstant,
  scheduleOf,
  type AppointmentRequest,
  type BookingDraft,
  type BookingOutcome,
  type HoursInput,
} from '@/lib/ai/appointment'
import type { BookingBranch } from '@/lib/ai/branches'
import { MAX_PHONE_REJECTIONS, missingDetails, type ContactEvents, type ContactState } from '@/lib/ai/contact'
import { cairoParts } from '@/lib/cairo-time'
import type { BookingMode } from '@/lib/types/bot-settings'
import type { SavedRecord } from '@/lib/ai/compose'
import { normalizePhone } from '@/lib/phone'
import { CLOSED_LEAD_STATUSES, type AiAppointment, type LeadExtractedData, type LeadStatus } from '@/lib/types/leads'

export type BookableLead = {
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
  branch_id: string | null
}

const COLUMNS =
  'id, name, phone, status, appointment_at, appointment_confirmed, showed_up, ai_appointment, ai_extracted_data, booking_draft, branch_id'

/** What a lead row is written with: the columns above, less the ones the sink supplies (client, conversation) */
export type LeadPatch = Partial<
  Pick<BookableLead, 'name' | 'phone' | 'status' | 'appointment_at' | 'appointment_confirmed' | 'ai_appointment' | 'ai_extracted_data' | 'booking_draft' | 'branch_id'>
> & { branch?: string }
export type LeadInsert = LeadPatch & { source_message_id: string | null; status: LeadStatus }
type BookedLead = Pick<BookableLead, 'status' | 'appointment_at' | 'appointment_confirmed' | 'ai_appointment'>

/**
 * WHERE THE LEAD ROWS ARE. Everything in this file decides (the gate, whose
 * time it is, what is pending, what the reply may state as saved); only
 * these four calls touch rows. The caller chooses the sink: leadsOf() is the
 * conversation's rows in the database, leadsInMemory() is the playground's,
 * handed back to the browser between messages so a test chat runs the same
 * code with nothing stored. One path: no function here is told which sink it
 * has.
 *
 * insert and update answer as the database does ({ error }), so the race
 * saveContact and recordAppointment handle (23505: a concurrent message
 * opened the lead first) is still theirs to read.
 */
export type LeadsSink = {
  /** The conversation's leads, oldest first */
  load(): Promise<BookableLead[]>
  /** Those with an appointment, oldest first (appointmentOnRecord) */
  loadBooked(): Promise<BookedLead[]>
  insert(row: LeadInsert): Promise<{ error: { code?: string; message: string } | null }>
  update(id: string, patch: LeadPatch): Promise<{ error: { code?: string; message: string } | null }>
}

/** The conversation's lead rows */
export function leadsOf(supabase: SupabaseClient, clientId: string, conversationId: string): LeadsSink {
  return {
    async load() {
      const { data, error } = await supabase
        .from('leads')
        .select(COLUMNS)
        .eq('conversation_id', conversationId)
        .order('created_at', { ascending: true })
        .returns<BookableLead[]>()
      if (error) throw error
      return data
    },
    async loadBooked() {
      const { data, error } = await supabase
        .from('leads')
        .select('status, appointment_at, appointment_confirmed, ai_appointment')
        .eq('conversation_id', conversationId)
        .not('appointment_at', 'is', null)
        .order('created_at', { ascending: true })
        .returns<BookedLead[]>()
      if (error) throw error
      return data
    },
    async insert(row) {
      const { error } = await supabase.from('leads').insert({ client_id: clientId, conversation_id: conversationId, ...row })
      return { error }
    },
    async update(id, patch) {
      const { error } = await supabase.from('leads').update(patch).eq('id', id)
      return { error }
    },
  }
}

/**
 * Lead rows that live in memory: what a test chat would have written, left
 * in `rows` for the caller to carry into the next message. Nothing reaches
 * the database. The one trigger the logic leans on is reproduced: a new time
 * is unconfirmed until the confirming step (sync_lead_attendance).
 */
export function leadsInMemory(initial: BookableLead[] = []): LeadsSink & { rows: BookableLead[] } {
  const rows: BookableLead[] = initial.map((row) => ({ ...row }))
  const apply = (lead: BookableLead, patch: LeadPatch) => {
    if (patch.appointment_at !== undefined && patch.appointment_at !== lead.appointment_at) lead.appointment_confirmed = false
    Object.assign(lead, patch)
  }
  return {
    rows,
    async load() {
      return rows.map((row) => ({ ...row }))
    },
    async loadBooked() {
      return rows
        .filter((row) => row.appointment_at !== null)
        .map(({ status, appointment_at, appointment_confirmed, ai_appointment }) => ({ status, appointment_at, appointment_confirmed, ai_appointment }))
    },
    async insert(row) {
      const lead: BookableLead = {
        id: randomUUID(),
        name: null,
        phone: null,
        status: 'new',
        appointment_at: null,
        appointment_confirmed: false,
        showed_up: null,
        ai_appointment: null,
        ai_extracted_data: null,
        booking_draft: null,
        branch_id: null,
      }
      apply(lead, row)
      rows.push(lead)
      return { error: null }
    },
    async update(id, patch) {
      const lead = rows.find((row) => row.id === id)
      if (lead) apply(lead, patch)
      return { error: null }
    },
  }
}

/** The branch a booking is for, as the lead records it: the reference, and the name the dashboard shows */
const branchColumns = (branch: Pick<BookingBranch, 'id' | 'name'> | null | undefined) =>
  branch ? { branch_id: branch.id, branch: branch.name } : {}

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
  leads,
  sourceMessageId,
  contact,
  events,
  draft,
}: {
  leads: LeadsSink
  sourceMessageId: string | null
  contact: ContactState
  /** What this message did to the name and number: only something it gave opens a lead */
  events: ContactEvents
  draft?: BookingDraft | null
}): Promise<SavedRecord> {
  const rows = await leads.load()
  let open = rows.find((lead) => !isClosed(lead)) ?? null
  const traced = { accepted_name: contact.name, accepted_phone: contact.phone, name_incomplete: contact.nameIncomplete }
  const draftPatch = draft === undefined ? {} : { booking_draft: draft }

  if (!open) {
    // A lead opens with something THIS message gave: a name or number carried
    // over from an earlier episode is not new (a customer who came back to
    // say thanks has not started another), and nor is a branch alone (a
    // visitor who asked a branch's price has not asked to book)
    const gave =
      events.name === 'stored' || events.name === 'stored_incomplete' || events.phone === 'stored' || Boolean(draft?.day || draft?.time)
    if (!gave) return { name: null, phone: null }
    const returningFrom = rows.findLast(isClosed) ?? null
    const row = { name: contact.name ?? returningFrom?.name ?? null, phone: contact.phone ?? returningFrom?.phone ?? null }
    const { error } = await leads.insert({
      source_message_id: sourceMessageId,
      ...row,
      ...draftPatch,
      status: 'new',
      ai_extracted_data: traced,
    })
    if (!error) return row
    // 23505: a concurrent message opened the lead first — write on that one
    if (error.code !== '23505') throw error
    open = (await leads.load()).find((lead) => !isClosed(lead)) ?? null
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
    const { error } = await leads.update(open.id, {
      ...patch,
      ...draftPatch,
      ...(Object.keys(patch).length > 0 ? { ai_extracted_data: { ...previous, ...traced } } : {}),
    })
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
  leads: LeadsSink
): Promise<{ held: boolean; draft: BookingDraft | null; hasDraft: boolean; branchId: string | null }> {
  const open = (await leads.load()).find((lead) => !isClosed(lead)) ?? null
  return {
    held: Boolean(open?.ai_appointment?.pending && !open.appointment_at),
    // The branch a held day (or a visit on record) is for
    branchId: open?.branch_id ?? null,
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
  leads,
  sourceMessageId,
  request,
  autoConfirm,
  businessHours,
  source,
  contact,
  hourFromPartOfDay = true,
  mode = 'appointment',
  branch = null,
  now = new Date(),
}: {
  leads: LeadsSink
  sourceMessageId: string | null
  request: AppointmentRequest
  /** bot_settings.auto_confirm_appointments */
  autoConfirm: boolean
  /** The branch's schedule: settles a bare hour ("at 9"), and refuses a day or time it is closed. None: nothing is checked */
  businessHours: HoursInput
  /** The branch the visit is for, written on the lead with it */
  branch?: Pick<BookingBranch, 'id' | 'name'> | null
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
  const rows = await leads.load()
  let open = rows.find((lead) => !isClosed(lead)) ?? null

  const dayOnly = mode === 'day_only'
  // A time-only change ("make it 7") keeps the day already on record, or asked for
  const keepDayOf = open?.appointment_at ?? (open?.ai_appointment?.pending ? open.ai_appointment.at : null)
  const resolved = dayOnly
    ? resolveDay(request, { now, businessHours })
    : resolveAppointment(request, { now, keepDayOf, businessHours, hourFromPartOfDay })
  if (resolved.status !== 'resolved') return resolved

  const returningFrom = rows.findLast(isClosed) ?? null
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
    const { error } = await leads.insert({
      source_message_id: sourceMessageId,
      name,
      phone,
      status: booked ? 'appointment_booked' : 'new',
      ...(booked ? { appointment_at: resolved.at, appointment_confirmed: confirmed } : {}),
      ai_appointment: aiAppointment,
      ...branchColumns(branch),
    })
    if (!error) return booked ? { status: 'booked', at: resolved.at, confirmed, changed: true, validated: resolved.validated } : needsDetails
    // 23505: a concurrent message opened the lead first — book on that one
    if (error.code !== '23505') throw error
    open = (await leads.load()).find((lead) => !isClosed(lead)) ?? null
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
      const { error } = await leads.update(open.id, { ai_appointment: aiAppointment, ...branchColumns(branch) })
      if (error) throw error
    }
    return needsDetails
  }

  return writeAppointment(leads, open, aiAppointment, branch)
}

/** The appointment itself, on a lead that has passed the gate */
async function writeAppointment(
  leads: LeadsSink,
  lead: BookableLead,
  aiAppointment: AiAppointment,
  branch: Pick<BookingBranch, 'id' | 'name'> | null = null
): Promise<BookingOutcome> {
  const { error } = await leads.update(lead.id, {
    appointment_at: aiAppointment.at,
    ai_appointment: aiAppointment,
    ...branchColumns(branch),
    ...(lead.status === 'new' || lead.status === 'contacted' ? { status: 'appointment_booked' as const } : {}),
  })
  if (error) throw error

  // A new time is unconfirmed again (sync_lead_attendance), so confirming it
  // is its own step
  if (aiAppointment.confirmed) {
    const { error: confirmError } = await leads.update(lead.id, { appointment_confirmed: true })
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
  leads,
  businessHours,
  contact = null,
  now = new Date(),
}: {
  leads: LeadsSink
  /** The schedule of the branch the held day is for; none: nothing is checked */
  businessHours: HoursInput
  /** The name and number as code holds them after this message: whether the bot has stopped asking for the number */
  contact?: ContactState | null
  now?: Date
}): Promise<BookingOutcome | null> {
  const open = (await leads.load()).find((lead) => !isClosed(lead)) ?? null
  const pending = open?.ai_appointment
  if (!open || !pending?.pending || open.appointment_at) return null

  const drop = async (outcome: BookingOutcome) => {
    const { error } = await leads.update(open.id, { ai_appointment: null })
    if (error) throw error
    return outcome
  }
  // A day-only visit has gone when its day has, not its placing time
  const gone = pending.day_only ? dayKey(pending.at) < dayKey(now) : new Date(pending.at).getTime() < now.getTime()
  if (gone) return drop({ status: 'past' })
  // Checked again just now, against the hours and closures as they stand
  const schedule = scheduleOf(businessHours)
  const refused = schedule ? refusalAt(schedule, pending.at, pending.day_only === true) : null
  if (refused) return drop(refused)
  const validated = schedule !== null
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
  return writeAppointment(leads, open, {
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
export async function heldRequest(leads: LeadsSink): Promise<boolean> {
  const open = (await leads.load()).find((lead) => !isClosed(lead)) ?? null
  return Boolean(open?.ai_appointment?.pending && !open.appointment_at)
}

/**
 * The appointment already on record for the conversation's open lead, as the
 * outcome of a message that didn't ask for one. For a reply that quotes the
 * appointment (the placeholder) without reporting it again: it is answered
 * from the record, not treated as a booking that never happened.
 * Throws on a database error.
 */
export async function appointmentOnRecord(leads: LeadsSink): Promise<BookingOutcome> {
  const data = await leads.loadBooked()
  const open = data.find((lead) => !CLOSED_LEAD_STATUSES.includes(lead.status))
  if (!open) return { status: 'none' }
  return { status: 'booked', at: open.appointment_at!, confirmed: open.appointment_confirmed, changed: false, validated: checkedOnRecord(open) }
}

/**
 * The visit on record, checked again against its branch's hours as they are
 * now: what is done when the visitor pushes back on it (5.4). A visit those
 * hours refuse (one booked before the day was checked, or hours edited
 * since) is cleared, so the lead stops holding a day known to be wrong, and
 * the refusal is returned for the visitor to be told. Only the assistant's
 * own visit is cleared: one a person set or confirmed is theirs to change,
 * so it returns null like a visit that passes. Throws on a database error.
 */
export async function recheckOnRecord({
  leads,
  businessHours,
}: {
  leads: LeadsSink
  businessHours: HoursInput
}): Promise<BookingOutcome | null> {
  const schedule = scheduleOf(businessHours)
  if (!schedule) return null
  const open = (await leads.load()).find((lead) => !isClosed(lead) && lead.appointment_at) ?? null
  if (!open?.appointment_at) return null
  const refused = refusalAt(schedule, open.appointment_at, open.ai_appointment?.day_only === true)
  if (!refused) return null
  const aiOwned =
    sameInstant(open.appointment_at, open.ai_appointment?.at) &&
    open.showed_up === null &&
    (!open.appointment_confirmed || open.ai_appointment?.confirmed === true)
  if (!aiOwned) return null
  const { error } = await leads.update(open.id, {
    appointment_at: null,
    appointment_confirmed: false,
    ai_appointment: null,
    ...(open.status === 'appointment_booked' ? { status: 'new' as const } : {}),
  })
  if (error) throw error
  return refused
}

/** What the open lead holds: the only source for a statement about what is saved */
export async function savedRecord(leads: LeadsSink): Promise<SavedRecord> {
  const open = (await leads.load()).find((lead) => !isClosed(lead)) ?? null
  return { name: open?.name ?? null, phone: open?.phone ?? null }
}
