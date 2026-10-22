import { describe, expect, it } from 'vitest'
import ar from '../../messages/ar.json'
import {
  DAY_ONLY_ORDER_INSTRUCTIONS,
  NO_BOOKING_INSTRUCTIONS,
  appointmentLine,
  formatAppointment,
  formatVisitDay,
  resolveDay,
  type AppointmentRequest,
} from '@/lib/ai/appointment'
import { BOOKING_ORDER_INSTRUCTIONS } from '@/lib/ai/booking-order'
import { buildSystemPrompt } from '@/lib/ai/bot'
import { EMPTY_CONTACT, validateName } from '@/lib/ai/contact'
import { appointmentState, isDayOnlyVisit } from '@/lib/types/appointments'
import { effectiveBookingMode, type BotSettingsInput, type BusinessHours } from '@/lib/types/bot-settings'
import { createUser, geminiError, geminiText, interceptRest, mockGemini, seedClient, serviceClient, userClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply, lastVisitorMessage, newVisitorId, openEveryDay, sendVisitorMessage } from './webhook'

/**
 * The three principles of the lead-capture build (October 2026):
 * 1. The name and the phone are the product: always taken, never behind a switch.
 * 2. The lead is written as it arrives, from its first piece, on one row; a
 *    client sees it once it holds a name and a phone, and RLS is what hides it.
 * 3. The booking shape is the business's: a day and a time, a day only, or none.
 */

const APPOINTMENT = ar.botReplies.appointment
const CONTACT = ar.botReplies.contact
const NUMBER = '01012345678'
const STORED = '+201012345678'

type LeadRow = {
  id: string
  name: string | null
  phone: string | null
  appointment_at: string | null
  booking_draft: Record<string, unknown> | null
  ai_appointment: Record<string, unknown> | null
  is_complete: boolean
}

/** The stand-in chat model answers from a script keyed by the visitor's message; the analysis reads the transcript */
function chatModel(script: Record<string, Response | (() => Response)>) {
  mockGemini((call: GeminiCall) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    if (call.kind === 'analysis') return geminiText(JSON.stringify(analyseTranscript(call)))
    const answer = script[lastVisitorMessage(call)]
    if (!answer) throw new Error(`The test's chat model has no answer for "${lastVisitorMessage(call)}"`)
    return typeof answer === 'function' ? answer() : answer.clone()
  })
}

async function visitor(options: Parameters<typeof seedClient>[0] = {}) {
  const seeded = await seedClient(options)
  const visitorId = newVisitorId()
  let conversationId: string | undefined
  const say = async (message: string) => {
    const { status, body } = await sendVisitorMessage(seeded.channelId, message, { visitorId, conversationId })
    expect(status).toBe(200)
    conversationId = body.conversationId as string
    return body.reply as string
  }
  // Every row, as the database holds it (the secret key: no RLS)
  const rows = async () => {
    const { data, error } = await seeded.supabase
      .from('leads')
      .select('id, name, phone, appointment_at, booking_draft, ai_appointment, is_complete')
      .eq('client_id', seeded.clientId)
      .returns<LeadRow[]>()
    if (error) throw new Error(error.message)
    return data
  }
  return { ...seeded, say, rows }
}

const TOMORROW_5PM: Partial<AppointmentRequest> = { day_type: 'tomorrow', hour: 5, period: 'afternoon' }

describe('1. the name and the phone never depend on a switch', () => {
  it('stores a number the visitor sends although the old lead switch is off on their client', async () => {
    chatModel({ [NUMBER]: botReply('تمام', null, { phone: NUMBER }) })
    const { say, rows, supabase, clientId } = await visitor()
    await supabase.from('bot_settings').update({ lead_qualification_enabled: false }).eq('client_id', clientId)

    await say(NUMBER)
    expect((await rows())[0]).toMatchObject({ phone: STORED })
  })

  it('stores a number sent while a person is answering, without the paid analysis finding it', async () => {
    mockGemini((call) => {
      if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
      // The analysis reads nothing: only code's own reading can store the number
      if (call.kind === 'analysis') return geminiText(JSON.stringify({ is_lead: false, confidence: 0, name: null, phone: null }))
      return botReply('أهلاً')
    })
    const { say, rows, supabase, clientId } = await visitor()
    await say('السلام عليكم')
    // This client's one conversation
    const { data: conversation } = await supabase.from('conversations').select('id').eq('client_id', clientId).single()
    await supabase.from('conversations').update({ auto_reply_enabled: false }).eq('id', conversation!.id)

    expect(await say(NUMBER)).toBeNull()
    expect((await rows())[0]).toMatchObject({ phone: STORED })
  })

  it('asks for one missing detail at a time: never a list of them, so no joining word in any language', () => {
    const at = '2026-10-20T10:00:00.000Z'
    for (const mode of ['appointment', 'day_only'] as const) {
      const line = appointmentLine({ status: 'needs_details', at, missing: ['name', 'phone'], handoff: false }, 'ar', { mode, nameStrictness: 'single' })
      expect(line).toContain(APPOINTMENT.missingNameAny)
      expect(line).not.toContain(APPOINTMENT.missingPhone)
    }
  })

  it('stores the name and the number for a business that books nothing, and says the team will follow up once both are there', async () => {
    chatModel({
      'أنا كريم مصطفى': botReply('أهلاً يا كريم', null, { name: 'كريم مصطفى' }),
      [NUMBER]: botReply('تمام', null, { phone: NUMBER }),
    })
    const { say, rows } = await visitor({ bookingMode: 'none' })

    expect(await say('أنا كريم مصطفى')).not.toContain(CONTACT.followUp)
    expect(await say(NUMBER)).toContain(CONTACT.followUp)
    expect(await rows()).toEqual([expect.objectContaining({ name: 'كريم مصطفى', phone: STORED, appointment_at: null, is_complete: true })])
  })

  it('takes whatever name the visitor gives by default, and two parts only where the business asks for them', () => {
    expect(validateName('سامح', 'single')).toBe('سامح')
    expect(validateName('م', 'single')).toBe('م')
    expect(validateName('سامح', 'two_parts')).toBeNull()
    expect(validateName('سامح علي', 'two_parts')).toBe('سامح علي')
    // Digits are not a name under either rule
    expect(validateName('كريم 123', 'single')).toBeNull()
  })
})

describe('2. the lead is written as it arrives', () => {
  it('writes the day the moment it is chosen, on a row the client does not see until the name and the number are there', async () => {
    chatModel({
      'عايز أحجز بكرة': botReply('', { day_type: 'tomorrow' }),
      'أنا كريم مصطفى': botReply('أهلاً', null, { name: 'كريم مصطفى' }),
      [NUMBER]: botReply('تمام', null, { phone: NUMBER }),
    })
    const { say, rows, organizationId, clientId } = await visitor()
    const orgAdmin = await createUser('org_admin', organizationId, 'Org Admin')
    const seenByClient = async () => (await userClient(orgAdmin.id).from('leads').select('id').eq('client_id', clientId)).data ?? []

    await say('عايز أحجز بكرة')
    const [first] = await rows()
    expect(first.booking_draft).toMatchObject({ day: { day_type: 'date' } })
    expect(first.is_complete).toBe(false)
    expect(await seenByClient()).toEqual([])

    await say('أنا كريم مصطفى')
    await say(NUMBER)
    const [same] = await rows()
    // The same row, now a lead
    expect(same).toMatchObject({ id: first.id, name: 'كريم مصطفى', phone: STORED, is_complete: true })
    expect(await seenByClient()).toEqual([{ id: first.id }])
  })

  it('keeps a number sent on a message whose reply failed', async () => {
    mockGemini((call) => {
      if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
      if (call.kind === 'analysis') return geminiError(503)
      return geminiError(503)
    })
    const { say, rows } = await visitor()

    // The visitor is told the service is down; the number is on the lead regardless
    await say(NUMBER)
    expect((await rows())[0]).toMatchObject({ phone: STORED })
  })

  it('loses nothing when the booking write fails, says so, and books on the next message without asking again', async () => {
    chatModel({
      [`أنا كريم مصطفى ${NUMBER}`]: botReply('أهلاً يا كريم', null, { name: 'كريم مصطفى', phone: NUMBER }),
      'بكرة الساعة 5 العصر': botReply('', TOMORROW_5PM, null),
      'تمام شكرا': botReply('العفو', null, null),
    })
    const { say, rows, ...seeded } = await visitor()
    await openEveryDay(seeded)
    await say(`أنا كريم مصطفى ${NUMBER}`)

    // The draft is written first (passed through); the appointment itself fails
    let patches = 0
    interceptRest({ path: '/leads', method: 'PATCH', times: 2 }, (passThrough) =>
      ++patches === 1 ? passThrough() : Response.json({ code: 'XX000', message: 'simulated database failure' }, { status: 500 })
    )
    expect(await say('بكرة الساعة 5 العصر')).toBe(APPOINTMENT.bookingSaveFailed)
    const [held] = await rows()
    expect(held.appointment_at).toBeNull()
    expect(held.booking_draft).toMatchObject({ day: { day_type: 'date' }, time: { hour: 5, period: 'afternoon' } })

    // Whatever the next message is about, what was given is booked: nothing is asked again
    const next = await say('تمام شكرا')
    const [booked] = await rows()
    expect(booked.appointment_at).not.toBeNull()
    expect(booked.booking_draft).toBeNull()
    expect(next).toBe(APPOINTMENT.bookedConfirmed.replace('{time}', formatAppointment(booked.appointment_at!, 'ar')))
  })
})

describe('2. the read policy is the enforcement', () => {
  async function world() {
    const { organizationId, clientId } = await seedClient()
    const admin = serviceClient()
    const insert = async (fields: Record<string, unknown>) => {
      const { data, error } = await admin.from('leads').insert({ client_id: clientId, ...fields }).select('id').single<{ id: string }>()
      if (error) throw new Error(error.message)
      return data.id
    }
    const ids = {
      draftOnly: await insert({ booking_draft: { day: { day_type: 'weekday', weekday: 'thursday' }, time: null, branch: null } }),
      phoneOnly: await insert({ phone: STORED }),
      nameOnly: await insert({ name: 'كريم' }),
      complete: await insert({ name: 'كريم مصطفى', phone: STORED }),
    }
    const orgAdmin = userClient((await createUser('org_admin', organizationId, 'Org Admin')).id)
    const superAdmin = userClient((await createUser('super_admin', null, 'Super Admin')).id)
    return { admin, clientId, ids, orgAdmin, superAdmin }
  }

  it('shows a client only the rows with a name and a phone; a super admin sees every row', async () => {
    const { clientId, ids, orgAdmin, superAdmin } = await world()
    const seen = async (as: typeof orgAdmin) =>
      ((await as.from('leads').select('id').eq('client_id', clientId)).data ?? []).map((row) => row.id).sort()

    expect(await seen(orgAdmin)).toEqual([ids.complete])
    expect(await seen(superAdmin)).toEqual(Object.values(ids).sort())
  })

  it('keeps the events of a hidden row from the client too', async () => {
    const { ids, orgAdmin, superAdmin } = await world()
    const events = async (as: typeof orgAdmin, lead: string) => (await as.from('lead_events').select('id').eq('lead_id', lead)).data ?? []

    expect(await events(orgAdmin, ids.phoneOnly)).toEqual([])
    expect(await events(superAdmin, ids.phoneOnly)).not.toEqual([])
    expect(await events(orgAdmin, ids.complete)).not.toEqual([])
  })

  it('lets a client neither change nor delete a hidden row', async () => {
    const { admin, ids, orgAdmin } = await world()
    expect((await orgAdmin.from('leads').update({ notes: 'x' }).eq('id', ids.phoneOnly).select('id')).data).toEqual([])
    expect((await orgAdmin.from('leads').delete().eq('id', ids.phoneOnly).select('id')).data).toEqual([])
    const { data } = await admin.from('leads').select('id, notes').eq('id', ids.phoneOnly).single()
    expect(data).toEqual({ id: ids.phoneOnly, notes: null })
  })

  it('counts leads, not rows, in the numbers: the client\'s and a super admin\'s alike', async () => {
    const { clientId, orgAdmin, superAdmin } = await world()
    const from = new Date(Date.now() - 86_400_000).toISOString()
    const to = new Date(Date.now() + 86_400_000).toISOString()
    const total = async (as: typeof orgAdmin) => {
      const { data, error } = await as.rpc('get_leads_over_time', { p_client_id: clientId, p_from: from, p_to: to, p_granularity: 'day' })
      if (error) throw new Error(error.message)
      return (data as { leads: number }[]).reduce((sum, row) => sum + Number(row.leads), 0)
    }
    expect(await total(orgAdmin)).toBe(1)
    expect(await total(superAdmin)).toBe(1)
  })
})

describe('3. the booking shape is the business\'s', () => {
  it('books a day-only visit on the day, at no time: whatever hour the model reported, none is stored as one or stated', async () => {
    chatModel({
      [`أنا كريم مصطفى ${NUMBER}`]: botReply('أهلاً يا كريم', null, { name: 'كريم مصطفى', phone: NUMBER }),
      'عايز أحجز بكرة الساعة 5': botReply('', TOMORROW_5PM, null),
    })
    const { say, rows, ...seeded } = await visitor({ bookingMode: 'day_only' })
    await openEveryDay(seeded, '13:00', '22:00')
    await say(`أنا كريم مصطفى ${NUMBER}`)

    const reply = await say('عايز أحجز بكرة الساعة 5')
    const [lead] = await rows()
    expect(lead.ai_appointment).toMatchObject({ day_only: true })
    // Placed at the day's opening, not at the 5 the model reported
    expect(formatAppointment(lead.appointment_at!, 'en')).toMatch(/1:00 PM$/)
    expect(reply).toBe(APPOINTMENT.bookedDay.replace('{day}', formatVisitDay(lead.appointment_at!, 'ar')))
    expect(reply).not.toMatch(/\d{1,2}:\d{2}/)
  })

  // Dr.Ali, 22 October 2026: no opening hours entered, and three closed days
  // in a row were each told «تمام — حجزك يوم …». Code had checked nothing.
  it('never says a day-only visit is booked when no opening hours could check the day: it is a request, from the first question to the restatement', async () => {
    const FRIDAY: Partial<AppointmentRequest> = { day_type: 'weekday', weekday: 'friday' }
    chatModel({
      'عايز أحجز الجمعة': botReply('', FRIDAY, null),
      'أنا كريم مصطفى': botReply('أهلاً يا كريم', null, { name: 'كريم مصطفى' }),
      [NUMBER]: botReply('تمام', null, { phone: NUMBER }),
      'كدا الحجز اتأكد ؟': botReply('أيوه، حجزك يوم {{appointment}}.', null, null),
    })
    const { say, rows } = await visitor({ bookingMode: 'day_only' })
    const asked = await say('عايز أحجز الجمعة')
    const [held] = await rows()
    const day = formatVisitDay(held.ai_appointment!.at as string, 'ar')

    expect(asked).toBe(APPOINTMENT.needDetailsDayRequest.replace('{day}', day).replace('{missing}', APPOINTMENT.missingNameAny))
    expect(await say('أنا كريم مصطفى')).toContain(APPOINTMENT.needDetailsDayRequest.replace('{day}', day).replace('{missing}', APPOINTMENT.missingPhone))

    const recorded = await say(NUMBER)
    expect(recorded).toContain(APPOINTMENT.bookedDayRequest.replace('{day}', day))
    expect(recorded).not.toContain('حجزك')
    const [lead] = await rows()
    expect(lead.ai_appointment).toMatchObject({ day_only: true, validated: false })

    // The model's own «حجزك» around the placeholder is not sent: code restates it
    expect(await say('كدا الحجز اتأكد ؟')).toBe(APPOINTMENT.bookedDayRequest.replace('{day}', day))
  })

  it('says «حجزك» for a day checked against the opening hours, and restates it in its own words, not the model\'s', async () => {
    chatModel({
      [`أنا كريم مصطفى ${NUMBER}`]: botReply('أهلاً يا كريم', null, { name: 'كريم مصطفى', phone: NUMBER }),
      'عايز أحجز بكرة': botReply('', { day_type: 'tomorrow' }, null),
      'كدا الحجز اتأكد ؟': botReply('أيوه، حجزك {{appointment}} مؤكد.', null, null),
    })
    const { say, rows, ...seeded } = await visitor({ bookingMode: 'day_only' })
    await openEveryDay(seeded, '13:00', '22:00')
    await say(`أنا كريم مصطفى ${NUMBER}`)

    const booked = await say('عايز أحجز بكرة')
    const [lead] = await rows()
    const day = formatVisitDay(lead.appointment_at!, 'ar')
    expect(lead.ai_appointment).toMatchObject({ day_only: true, validated: true })
    expect(booked).toBe(APPOINTMENT.bookedDay.replace('{day}', day))
    expect(await say('كدا الحجز اتأكد ؟')).toBe(APPOINTMENT.bookedDay.replace('{day}', day))
  })

  it('tells a visitor who already has an unchecked day-only visit that it is a request', () => {
    const at = '2026-10-23T09:00:00.000Z'
    const rules = { mode: 'day_only', nameStrictness: 'single' } as const
    const day = formatVisitDay(at, 'ar')
    expect(appointmentLine({ status: 'kept', at }, 'ar', rules)).toBe(APPOINTMENT.keptDayRequest.replace('{day}', day))
    expect(appointmentLine({ status: 'kept', at, validated: true }, 'ar', rules)).toBe(APPOINTMENT.keptDay.replace('{day}', day))
    // An appointment business is unchanged: confirmed or not decides its sentence
    expect(appointmentLine({ status: 'booked', at, confirmed: false, changed: true }, 'ar')).toBe(
      APPOINTMENT.bookedRequest.replace('{time}', formatAppointment(at, 'ar'))
    )
  })

  it('never asks a day-only visitor for a time: the model\'s question about one is removed and the day is asked for', async () => {
    chatModel({ 'عايز أحجز': botReply('أكيد! تحب تيجي الساعة كام؟', null, null) })
    const { say } = await visitor({ bookingMode: 'day_only' })
    // What else the model said stays; its question about a time goes
    expect(await say('عايز أحجز')).toBe(`أكيد!\n${APPOINTMENT.askTime}`)
  })

  it('books nothing for a business that does not book through the chat, whatever the model reports', async () => {
    chatModel({ 'عايز أحجز بكرة الساعة 5 العصر': botReply('تمام، حجزتلك {{appointment}}', TOMORROW_5PM, null, 'الفريق هيكلمك') })
    const { say, rows, ...seeded } = await visitor({ bookingMode: 'none' })
    await openEveryDay(seeded)

    const reply = await say('عايز أحجز بكرة الساعة 5 العصر')
    expect(reply).not.toContain('{{appointment}}')
    expect(reply).not.toContain(APPOINTMENT.askTime)
    expect(await rows()).toEqual([])
  })

  it('follows the opening hours until the business chooses: appointments once hours are set, none before', () => {
    const hours = (enabled: boolean) => ({ enabled }) as BusinessHours
    expect(effectiveBookingMode({ booking_mode: null, business_hours: null })).toBe('none')
    expect(effectiveBookingMode({ booking_mode: null, business_hours: hours(false) })).toBe('none')
    expect(effectiveBookingMode({ booking_mode: null, business_hours: hours(true) })).toBe('appointment')
    expect(effectiveBookingMode({ booking_mode: 'day_only', business_hours: hours(true) })).toBe('day_only')
  })

  it('gives each shape its own order: the hour-asking order only to a business that books hours', () => {
    const settings: BotSettingsInput = {
      system_prompt: 'You are the clinic assistant.',
      tone: 'friendly',
      language: 'ar',
      temperature: 0.7,
      max_response_length: 500,
      welcome_message: 'Hello',
      fallback_message: 'Sorry',
      service_unavailable_message: 'Down',
      auto_confirm_appointments: true,
      business_hours: null,
      booking_mode: 'appointment',
      name_strictness: 'single',
    }
    const prompt = (booking_mode: BotSettingsInput['booking_mode']) =>
      buildSystemPrompt({ name: 'Clinic', industry: null, description: null }, { ...settings, booking_mode }, [], new Date(), EMPTY_CONTACT)

    expect(prompt('appointment')).toContain(BOOKING_ORDER_INSTRUCTIONS)
    expect(prompt('day_only')).toContain(DAY_ONLY_ORDER_INSTRUCTIONS)
    expect(prompt('day_only')).not.toContain(BOOKING_ORDER_INSTRUCTIONS)
    expect(prompt('none')).toContain(NO_BOOKING_INSTRUCTIONS)
    // The name and the number are asked to be reported in every shape
    for (const mode of ['appointment', 'day_only', 'none'] as const) expect(prompt(mode)).toContain('"contact"')
  })
})

describe('a day-only visit in the dashboard', () => {
  // Placed at 13:00 Cairo on Tuesday 20 October 2026
  const at = '2026-10-20T10:00:00.000Z'
  const visit = { appointment_at: at, showed_up: null, ai_appointment: { at, day_only: true as const } }

  it('is day-only only while it stays where the assistant placed it: a time the team sets is a real one', () => {
    expect(isDayOnlyVisit(visit)).toBe(true)
    expect(isDayOnlyVisit({ ...visit, appointment_at: '2026-10-20T12:30:00.000Z' })).toBe(false)
    expect(isDayOnlyVisit({ ...visit, ai_appointment: { at } })).toBe(false)
  })

  it('is not late at its placing time, only once its day has gone', () => {
    expect(appointmentState(visit, new Date('2026-10-20T15:00:00Z'))).toBe('today')
    expect(appointmentState(visit, new Date('2026-10-21T08:00:00Z'))).toBe('late')
    // The same instant as an ordinary appointment is late by then
    expect(appointmentState({ ...visit, ai_appointment: null }, new Date('2026-10-20T15:00:00Z'))).toBe('late')
  })
})

describe('a day-only visit\'s day', () => {
  // Monday 19 October 2026, Cairo (UTC+3)
  const hours: BusinessHours = {
    enabled: true,
    timezone: 'Africa/Cairo',
    days: {
      sat: { open: true, from: '13:00', to: '22:00' },
      sun: { open: true, from: '13:00', to: '22:00' },
      mon: { open: true, from: '13:00', to: '22:00' },
      tue: { open: true, from: '13:00', to: '22:00' },
      wed: { open: true, from: '13:00', to: '22:00' },
      thu: { open: true, from: '13:00', to: '22:00' },
      fri: { open: false, from: '13:00', to: '22:00' },
    },
  }
  const request = (part: Partial<AppointmentRequest>): AppointmentRequest => ({
    day_type: 'none',
    weekday: null,
    day_of_month: null,
    month: null,
    year: null,
    hour: null,
    minute: null,
    period: 'unspecified',
    needs_team_check: null,
    ...part,
  })
  const at = (iso: string) => new Date(iso)

  it('is placed at that day\'s opening, whatever hour was said', () => {
    expect(resolveDay(request({ day_type: 'tomorrow', hour: 9, period: 'night' }), { now: at('2026-10-19T09:00:00Z'), businessHours: hours })).toEqual({
      status: 'resolved',
      at: '2026-10-20T10:00:00.000Z',
      approximate: false,
      validated: true,
    })
  })

  it('is placed at midday when the business has set no hours', () => {
    expect(resolveDay(request({ day_type: 'tomorrow' }), { now: at('2026-10-19T09:00:00Z') })).toMatchObject({ at: '2026-10-20T09:00:00.000Z', validated: false })
  })

  it('is refused on a day the business is closed', () => {
    expect(resolveDay(request({ day_type: 'weekday', weekday: 'friday' }), { now: at('2026-10-19T09:00:00Z'), businessHours: hours })).toEqual({
      status: 'outside_hours',
      hours: { weekday: 5, open: false },
    })
  })

  it('counts today until closing, and a weekday named after closing is next week\'s', () => {
    const evening = at('2026-10-19T19:30:00Z') // 22:30 in Cairo, after closing
    expect(resolveDay(request({ day_type: 'today' }), { now: at('2026-10-19T15:00:00Z'), businessHours: hours })).toMatchObject({ status: 'resolved' })
    expect(resolveDay(request({ day_type: 'today' }), { now: evening, businessHours: hours })).toEqual({ status: 'past' })
    expect(resolveDay(request({ day_type: 'weekday', weekday: 'monday' }), { now: evening, businessHours: hours })).toMatchObject({
      at: '2026-10-26T10:00:00.000Z',
    })
  })

  it('asks for the day when none was said', () => {
    expect(resolveDay(request({ hour: 5, period: 'afternoon' }), { now: at('2026-10-19T09:00:00Z'), businessHours: hours })).toEqual({
      status: 'incomplete',
      missing: ['day'],
      day: null,
      time: null,
    })
  })
})
