import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  resolveAppointment,
  sameInstant,
  type AppointmentRequest,
  type BookingOutcome,
} from '@/lib/ai/appointment'
import type { BusinessHours } from '@/lib/types/bot-settings'
import { CLOSED_LEAD_STATUSES, type AiAppointment, type LeadStatus } from '@/lib/types/leads'

type BookableLead = {
  id: string
  name: string | null
  phone: string | null
  status: LeadStatus
  appointment_at: string | null
  appointment_confirmed: boolean
  showed_up: boolean | null
  ai_appointment: AiAppointment | null
}

const COLUMNS = 'id, name, phone, status, appointment_at, appointment_confirmed, showed_up, ai_appointment'

/**
 * Records the appointment the visitor asked for on the conversation's open
 * lead, before the reply is sent — the reply then quotes what this returns.
 * A specific day and time is intent enough to open a lead when there is none
 * (a returning customer's name and phone carry over); the analysis that runs
 * after the reply fills in the rest.
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
  now = new Date(),
}: {
  supabase: SupabaseClient
  clientId: string
  conversationId: string
  sourceMessageId: string | null
  request: AppointmentRequest
  /** bot_settings.auto_confirm_appointments */
  autoConfirm: boolean
  /** Settles a bare hour ("at 9") when only one reading is within them */
  businessHours: BusinessHours | null
  /**
   * 'reply': read by the reply call; opens a lead if there is none.
   * 'analysis': read by the analysis of a message the bot didn't answer; only
   * ever set on the lead that analysis found or created.
   */
  source: 'reply' | 'analysis'
  now?: Date
}): Promise<BookingOutcome> {
  const loadLeads = async () => {
    const { data, error } = await supabase
      .from('leads')
      .select(COLUMNS)
      .eq('conversation_id', conversationId)
      .order('created_at', { ascending: true })
      .returns<BookableLead[]>()
    if (error) throw error
    return data
  }
  const isClosed = (lead: BookableLead) => CLOSED_LEAD_STATUSES.includes(lead.status)

  const leads = await loadLeads()
  let open = leads.find((lead) => !isClosed(lead)) ?? null

  // A time-only change ("make it 7") keeps the day already on record
  const resolved = resolveAppointment(request, { now, keepDayOf: open?.appointment_at ?? null, businessHours })
  if (resolved.status !== 'resolved') return resolved
  const aiAppointment: AiAppointment = {
    at: resolved.at,
    approximate: resolved.approximate,
    confirmed: autoConfirm,
    source,
  }

  if (!open) {
    if (source === 'analysis') return { status: 'none' }
    const returningFrom = leads.findLast(isClosed) ?? null
    const { error } = await supabase.from('leads').insert({
      client_id: clientId,
      conversation_id: conversationId,
      source_message_id: sourceMessageId,
      name: returningFrom?.name ?? null,
      phone: returningFrom?.phone ?? null,
      status: 'appointment_booked',
      appointment_at: resolved.at,
      appointment_confirmed: autoConfirm,
      ai_appointment: aiAppointment,
    })
    if (!error) return { status: 'booked', at: resolved.at, confirmed: autoConfirm, changed: true }
    // 23505: a concurrent message opened the lead first — book on that one
    if (error.code !== '23505') throw error
    open = (await loadLeads()).find((lead) => !isClosed(lead)) ?? null
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

  const { error } = await supabase
    .from('leads')
    .update({
      appointment_at: resolved.at,
      ai_appointment: aiAppointment,
      ...(open.status === 'new' || open.status === 'contacted' ? { status: 'appointment_booked' } : {}),
    })
    .eq('id', open.id)
  if (error) throw error

  // A new time is unconfirmed again (sync_lead_attendance), so confirming it
  // is its own step
  if (autoConfirm) {
    const { error: confirmError } = await supabase.from('leads').update({ appointment_confirmed: true }).eq('id', open.id)
    if (confirmError) throw confirmError
  }
  return { status: 'booked', at: resolved.at, confirmed: autoConfirm, changed: true }
}
