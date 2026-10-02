import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ar from '../../messages/ar.json'
import { testBot } from '@/lib/actions/playground'
import { geminiCalls, geminiError, geminiText, mockGemini, seedClient, serviceClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply, newVisitorId, sendVisitorMessage } from './webhook'

// The playground's signed-in admin
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({ supabase: serviceClient(), profile: { id: 'client-admin', role: 'org_admin' } }),
  isImpersonating: async () => false,
  canManage: () => true,
}))

const TEXT = ar.botReplies.appointment

// Monday 5 October 2026, 12:00 in Cairo (UTC+3)
beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-05T09:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
})

const THURSDAY_6PM = '2026-10-08T15:00:00.000Z'
const BOOKING_MESSAGE = 'أنا كريم مصطفى ورقمي 01012345678، عايز أحجز تنظيف أسنان الخميس الساعة 6 المغرب'
const NINE_MESSAGE = 'أنا كريم مصطفى ورقمي 01012345678، عايز أحجز بكرة الساعة 9'
// "بكرة الساعة 9": the hour as said, no part of the day
const TOMORROW_AT_9 = { day_type: 'tomorrow', hour: 9, period: 'unspecified' }

function models(reply: (call: GeminiCall) => Response) {
  mockGemini((call) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    return call.kind === 'analysis' ? geminiText(JSON.stringify(analyseTranscript(call))) : reply(call)
  })
}

type Seeded = Awaited<ReturnType<typeof seedClient>>
type Lead = {
  appointment_at: string | null
  appointment_confirmed: boolean
  status: string
  ai_appointment: { at: string; confirmed: boolean; source?: string } | null
}

async function leadsOf({ supabase, clientId }: Seeded) {
  const { data } = await supabase
    .from('leads')
    .select('appointment_at, appointment_confirmed, status, ai_appointment')
    .eq('client_id', clientId)
    .returns<Lead[]>()
  return data!
}
const instant = (value: string | null) => (value ? new Date(value).toISOString() : null)

const openHours = (from: string, to: string) => ({
  enabled: true,
  timezone: 'Africa/Cairo',
  days: Object.fromEntries(['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'].map((day) => [day, { open: true, from, to }])),
})
async function setBusinessHours({ supabase, clientId }: Seeded, from: string, to: string) {
  const { error } = await supabase.from('bot_settings').update({ business_hours: openHours(from, to) }).eq('client_id', clientId)
  expect(error).toBeNull()
}

describe('messages the bot does not answer', () => {
  it('reads the appointment in the analysis when an agent has taken over, unconfirmed and marked as from the analysis', async () => {
    models(() => geminiText('لا يُفترض أن يُستدعى'))
    const seeded = await seedClient()
    const visitorId = newVisitorId()
    const { data: conversation } = await seeded.supabase
      .from('conversations')
      .insert({
        client_id: seeded.clientId,
        channel_id: seeded.channelId,
        contact_identifier: visitorId,
        status: 'new',
        auto_reply_enabled: false,
      })
      .select('id')
      .single<{ id: string }>()

    const { body } = await sendVisitorMessage(seeded.channelId, BOOKING_MESSAGE, { visitorId, conversationId: conversation!.id })

    expect(body).toMatchObject({ ok: true, reply: null, handoff: true })
    expect(geminiCalls.filter((call) => call.kind === 'reply')).toHaveLength(0)
    const [lead, ...rest] = await leadsOf(seeded)
    expect(rest).toEqual([])
    expect(instant(lead.appointment_at)).toBe(THURSDAY_6PM)
    // Auto-confirm is on for this client, but nobody told the visitor anything
    expect(lead).toMatchObject({ status: 'appointment_booked', appointment_confirmed: false })
    expect(lead.ai_appointment).toMatchObject({ source: 'analysis', confirmed: false })
    expect(instant(lead.ai_appointment!.at)).toBe(THURSDAY_6PM)
  })

  it('reads the appointment in the analysis when the reply fails', async () => {
    models(() => geminiError(503))
    const seeded = await seedClient()

    const { status, body } = await sendVisitorMessage(seeded.channelId, BOOKING_MESSAGE)

    // The fallback message, not an error
    expect(status).toBe(200)
    expect(body).toMatchObject({ ok: true, fallback: true })
    const [lead] = await leadsOf(seeded)
    expect(instant(lead.appointment_at)).toBe(THURSDAY_6PM)
    expect(lead.ai_appointment).toMatchObject({ source: 'analysis' })
  })

  it('leaves the appointment to the reply call when the bot answers: the analysis is not asked for one', async () => {
    models(() => botReply('حجزتلك {{appointment}}.', { day_type: 'weekday', weekday: 'thursday', hour: 6, period: 'evening' }))
    const seeded = await seedClient()

    await sendVisitorMessage(seeded.channelId, BOOKING_MESSAGE)

    const analysis = geminiCalls.find((call) => call.kind === 'analysis')!
    expect(JSON.stringify(analysis.body)).not.toContain('"appointment"')
    const [lead] = await leadsOf(seeded)
    expect(lead.ai_appointment).toMatchObject({ source: 'reply', confirmed: true })
    expect(lead).toMatchObject({ appointment_confirmed: true })
  })
})

describe('an hour with no part of the day', () => {
  it("takes the reading inside the client's business hours: 9 is 9 PM for a clinic open 4 PM to 10 PM", async () => {
    models(() => botReply('حجزتلك {{appointment}}.', TOMORROW_AT_9))
    const seeded = await seedClient()
    await setBusinessHours(seeded, '16:00', '22:00')

    const { body } = await sendVisitorMessage(seeded.channelId, NINE_MESSAGE)

    const [lead] = await leadsOf(seeded)
    expect(instant(lead.appointment_at)).toBe('2026-10-06T18:00:00.000Z')
    expect(body.reply).toBe(`حجزتلك الثلاثاء 6 أكتوبر الساعة 9:00 مساءً.\n${TEXT.confirmed}`)
  })

  it.each([
    ['there are no business hours', null],
    ['both readings fall inside the business hours', ['08:00', '22:00']],
  ])('asks morning or evening and books nothing when %s', async (_name, hours) => {
    // The model claims a booking; nothing may be booked or promised
    models(() => botReply('تمام، حجزتلك {{appointment}}.', TOMORROW_AT_9))
    const seeded = await seedClient()
    if (hours) await setBusinessHours(seeded, hours[0], hours[1])

    const { body } = await sendVisitorMessage(seeded.channelId, NINE_MESSAGE)

    expect(body.reply).toBe(TEXT.askPeriod.replace('{hour}', '9'))
    expect((await leadsOf(seeded)).map((lead) => lead.appointment_at)).toEqual([null])
  })
})

describe('the playground', () => {
  it('flags the appointment in its reply as simulated, and books nothing', async () => {
    models(() => botReply('حجزتلك {{appointment}}.', { day_type: 'weekday', weekday: 'thursday', hour: 6, period: 'evening' }))
    const seeded = await seedClient()

    const result = await testBot(seeded.clientId, [{ role: 'user', content: BOOKING_MESSAGE }])

    expect(result).toEqual({
      ok: true,
      reply: `حجزتلك الخميس 8 أكتوبر الساعة 6:00 مساءً.\n${TEXT.confirmed}`,
      simulatedAppointment: THURSDAY_6PM,
    })
    expect(await leadsOf(seeded)).toEqual([])

    // An ordinary reply carries no such flag
    models(() => botReply('أهلاً بيك، تحت أمرك', null))
    expect(await testBot(seeded.clientId, [{ role: 'user', content: 'السلام عليكم' }])).toEqual({
      ok: true,
      reply: 'أهلاً بيك، تحت أمرك',
    })
  })
})
