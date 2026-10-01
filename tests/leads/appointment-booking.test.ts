import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ar from '../../messages/ar.json'
import { geminiCalls, geminiText, mockGemini, seedClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply, newVisitorId, sendVisitorMessage } from './webhook'

const TEXT = ar.botReplies.appointment

// Monday 5 October 2026, 12:00 in Cairo (UTC+3): "Thursday" is the 8th
const NOW = '2026-10-05T09:00:00.000Z'
const THURSDAY_6PM = '2026-10-08T15:00:00.000Z'
const THURSDAY_6PM_TEXT = 'الخميس 8 أكتوبر الساعة 6:00 مساءً'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})
afterEach(() => {
  vi.useRealTimers()
})

const BOOKING_MESSAGE = 'أنا كريم مصطفى ورقمي 01012345678، عايز أحجز تنظيف أسنان الخميس الساعة 6 المغرب'
// What the chat model is asked to report for that sentence: components, no arithmetic
const THURSDAY_6_EVENING = { day_type: 'weekday', weekday: 'thursday', hour: 6, period: 'evening' }

/** The chat model answers with `reply`; the analysis model reads the transcript */
function chatModel(reply: (call: GeminiCall) => Response) {
  mockGemini((call) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    return call.kind === 'analysis' ? geminiText(JSON.stringify(analyseTranscript(call))) : reply(call)
  })
}

type Booked = { status: string; appointment_at: string | null; appointment_confirmed: boolean; name: string | null }

async function book(
  seeded: Awaited<ReturnType<typeof seedClient>>,
  message = BOOKING_MESSAGE,
  visitor: { visitorId?: string; conversationId?: string } = {}
) {
  const { status, body } = await sendVisitorMessage(seeded.channelId, message, visitor)
  expect(status).toBe(200)
  const conversationId = body.conversationId as string
  const { data: leads } = await seeded.supabase
    .from('leads')
    .select('status, appointment_at, appointment_confirmed, name')
    .eq('conversation_id', conversationId)
    .returns<Booked[]>()
  const { data: messages } = await seeded.supabase
    .from('messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
    .order('created_at', { ascending: false })
    .limit(1)
  return { reply: body.reply as string, stored: messages![0].content as string, leads: leads!, conversationId }
}

const instant = (value: string | null) => (value ? new Date(value).toISOString() : null)

describe('one appointment parser: the reply quotes the stored appointment', () => {
  it('stores "الخميس الساعة 6 المغرب" as one fixed instant and puts that same value in the reply', async () => {
    chatModel(() => botReply('تمام يا أستاذ كريم، حجزتلك {{appointment}} لتنظيف الأسنان.', THURSDAY_6_EVENING))
    const seeded = await seedClient()

    const { reply, stored, leads } = await book(seeded)

    expect(leads).toHaveLength(1)
    expect(instant(leads[0].appointment_at)).toBe(THURSDAY_6PM)
    expect(leads[0]).toMatchObject({ status: 'appointment_booked', name: 'كريم مصطفى' })
    // The visitor is told the time that is on record, and nothing else
    expect(reply).toContain(`حجزتلك ${THURSDAY_6PM_TEXT} لتنظيف الأسنان.`)
    expect(reply).not.toContain('{{')
    expect(stored).toBe(reply)
    // One reading of the sentence: the analysis no longer has its own
    const analysis = geminiCalls.find((call) => call.kind === 'analysis')!
    expect(JSON.stringify(analysis.body.generationConfig)).not.toContain('appointment')
  })

  it('gives the same instant and the same reply every time, however the model words the same request', async () => {
    // Five answers a model could give for "الخميس الساعة 6 المغرب"
    const readings = [
      { day_type: 'weekday', weekday: 'thursday', hour: 6, period: 'evening' },
      { day_type: 'weekday', weekday: 'thursday', hour: 6, minute: 0, period: 'evening' },
      { day_type: 'weekday', weekday: 'thursday', hour: 18, period: 'evening' },
      { day_type: 'weekday', weekday: 'thursday', hour: 18, minute: 0, period: 'unspecified' },
      { day_type: 'date', day_of_month: 8, month: 10, hour: 6, period: 'evening' },
    ]
    const results: { at: string | null; reply: string }[] = []
    for (const reading of readings) {
      chatModel(() => botReply('حجزتلك {{appointment}}.', reading))
      const { reply, leads } = await book(await seedClient())
      results.push({ at: instant(leads[0].appointment_at), reply })
    }

    expect(new Set(results.map((r) => r.at))).toEqual(new Set([THURSDAY_6PM]))
    expect(new Set(results.map((r) => r.reply)).size).toBe(1)
    expect(results[0].reply).toContain(THURSDAY_6PM_TEXT)
  })

  it('books nothing for "الأسبوع الجاي", asks for the time, and never invents a value', async () => {
    const seeded = await seedClient()

    // The model does as told: no appointment, and it asks
    chatModel(() => botReply('تمام يا أستاذ كريم، تحب يوم إيه والساعة كام؟', null))
    const asked = await book(seeded, 'أنا كريم مصطفى ورقمي 01012345678، عايز أحجز الأسبوع الجاي')
    expect(asked.reply).toBe('تمام يا أستاذ كريم، تحب يوم إيه والساعة كام؟')
    expect(asked.leads.map((lead) => lead.appointment_at)).toEqual([null])

    // The model misbehaves: an hour with no day, and a reply that claims a booking
    chatModel(() => botReply('تمام، حجزتلك {{appointment}}.', { day_type: 'none', hour: 5, period: 'afternoon' }))
    const invented = await book(seeded, 'أنا كريم مصطفى ورقمي 01012345678، عايز أحجز الأسبوع الجاي')
    expect(invented.reply).toBe(TEXT.askTime)
    expect(invented.stored).toBe(TEXT.askTime)
    expect(invented.leads.map((lead) => lead.appointment_at)).toEqual([null])
  })

  it('confirms the appointment at once when auto-confirm is on (the default), and says so', async () => {
    chatModel(() => botReply('حجزتلك {{appointment}}.', THURSDAY_6_EVENING))
    const seeded = await seedClient()

    const { reply, leads } = await book(seeded)

    expect(leads[0]).toMatchObject({ appointment_confirmed: true })
    expect(instant(leads[0].appointment_at)).toBe(THURSDAY_6PM)
    expect(reply).toBe(`حجزتلك ${THURSDAY_6PM_TEXT}.\n${TEXT.confirmed}`)
  })

  it('leaves the appointment for the team to confirm when auto-confirm is off, and says it will be confirmed', async () => {
    chatModel(() => botReply('حجزتلك {{appointment}}.', THURSDAY_6_EVENING))
    const seeded = await seedClient()
    const { error } = await seeded.supabase
      .from('bot_settings')
      .update({ auto_confirm_appointments: false })
      .eq('client_id', seeded.clientId)
    expect(error).toBeNull()

    const { reply, leads } = await book(seeded)

    expect(leads[0]).toMatchObject({ appointment_confirmed: false })
    expect(instant(leads[0].appointment_at)).toBe(THURSDAY_6PM)
    expect(reply).toBe(`حجزتلك ${THURSDAY_6PM_TEXT}.\n${TEXT.pending}`)
    expect(reply).not.toContain(TEXT.confirmed)
  })

  it('moves its own appointment when the visitor changes the time, and keeps one the team set', async () => {
    chatModel(() => botReply('حجزتلك {{appointment}}.', THURSDAY_6_EVENING))
    const seeded = await seedClient()
    const visitorId = newVisitorId()
    const { conversationId } = await book(seeded, BOOKING_MESSAGE, { visitorId })

    // "خليها 7 بالليل": a new hour, the day already chosen
    chatModel(() => botReply('تمام، خليناها {{appointment}}.', { day_type: 'none', hour: 7, period: 'night' }))
    const moved = await book(seeded, 'خليها 7 بالليل', { visitorId, conversationId })
    expect(instant(moved.leads[0].appointment_at)).toBe('2026-10-08T16:00:00.000Z')
    expect(moved.leads[0]).toMatchObject({ appointment_confirmed: true })
    expect(moved.reply).toBe(`تمام، خليناها الخميس 8 أكتوبر الساعة 7:00 مساءً.\n${TEXT.confirmed}`)

    // The team reschedules by hand: from now on the time is theirs
    const teamTime = '2026-10-10T08:00:00.000Z'
    await seeded.supabase.from('leads').update({ appointment_at: teamTime }).eq('conversation_id', conversationId)
    chatModel(() => botReply('حجزتلك {{appointment}}.', THURSDAY_6_EVENING))
    const kept = await book(seeded, 'لا خليها الخميس الساعة 6 المغرب', { visitorId, conversationId })
    expect(instant(kept.leads[0].appointment_at)).toBe(teamTime)
    expect(kept.reply).toBe(TEXT.kept.replace('{time}', 'السبت 10 أكتوبر الساعة 11:00 صباحاً'))
  })
})
