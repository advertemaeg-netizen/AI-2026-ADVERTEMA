import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ar from '../../messages/ar.json'
import { geminiText, mockGemini, seedClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply, lastVisitorMessage, newVisitorId, openEveryDay, sendVisitorMessage, setBranchHours } from './webhook'

/**
 * What the visitor has said toward one appointment survives the messages in
 * between, a refusal included: a refusal takes back the part that was refused,
 * never the rest. The first case is the demo widget's conversation of 18
 * October 2026 (0c6b8d64), with the model's own output from that day, word for
 * word, as the stand-in model's answers.
 */

const APPOINTMENT = ar.botReplies.appointment

// Sunday 18 October 2026, 09:53 in Cairo (UTC+3): when the conversation took place
const NOW = '2026-10-18T06:53:00.000Z'

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})
afterEach(() => {
  vi.useRealTimers()
})

function chatModel(script: Record<string, Response>) {
  mockGemini((call: GeminiCall) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    if (call.kind === 'analysis') return geminiText(JSON.stringify(analyseTranscript(call)))
    const answer = script[lastVisitorMessage(call)]
    if (!answer) throw new Error(`The test's chat model has no answer for "${lastVisitorMessage(call)}"`)
    return answer.clone()
  })
}

const NAME = 'مصطفى محمد الباز'
const THURSDAY = (hour: number | null, period: string, needs_team_check = true) => ({
  day_type: 'weekday',
  weekday: 'thursday',
  day_of_month: null,
  month: null,
  year: null,
  hour,
  minute: null,
  period,
  needs_team_check,
})

async function visitor(hours: (seeded: Awaited<ReturnType<typeof seedClient>>) => Promise<void>) {
  const seeded = await seedClient()
  await hours(seeded)
  const visitorId = newVisitorId()
  let conversationId: string | undefined
  const say = async (message: string) => {
    const { status, body } = await sendVisitorMessage(seeded.channelId, message, { visitorId, conversationId })
    expect(status).toBe(200)
    conversationId = body.conversationId as string
    return body.reply as string
  }
  const appointmentAt = async () => {
    const { data, error } = await seeded.supabase
      .from('leads')
      .select('appointment_at')
      .eq('client_id', seeded.clientId)
      .returns<{ appointment_at: string | null }[]>()
    if (error) throw new Error(error.message)
    return data.map((lead) => (lead.appointment_at ? new Date(lead.appointment_at).toISOString() : null))
  }
  return { say, appointmentAt }
}

/** Every day noon to 10 PM, Friday closed, on the client's branch */
async function closedOnFriday(seeded: Awaited<ReturnType<typeof seedClient>>) {
  const noonToTen: [string, string][] = [['12:00', '22:00']]
  await setBranchHours(seeded, { sat: noonToTen, sun: noonToTen, mon: noonToTen, tue: noonToTen, wed: noonToTen, thu: noonToTen })
}

describe('a partial booking is kept across messages, and a refusal narrows it', () => {
  it('books "7 بالليل" on Thursday, the day asked for before two refused times (conversation 0c6b8d64)', async () => {
    chatModel({
      [NAME]: botReply('أهلاً يا مصطفى، رقم موبايلك إيه؟', null, { name: NAME, phone: null }),
      '1234': botReply('محتاج أعرف الخدمة المطلوبة، والفرع، واليوم والساعة اللي يناسبوك.', null, { name: NAME, phone: '1234' }),
      '01097654189': botReply('تمام يا مصطفى، محتاج تحجز خدمة إيه؟', null, { name: NAME, phone: '01097654189' }),
      'التجمع': botReply('تمام يا مصطفى، تحب أنهي يوم والساعة كام؟', null, null),
      'ايه المواعيد المتاحه': botReply(
        'فرع التجمع مفتوح من السبت للخميس، من الساعة 1 الضهر لـ10 بالليل، ومغلق يوم الجمعة. تحب تيجي أنهي يوم والساعة كام؟',
        null,
        null
      ),
      'الخميس الساعة 11': botReply('', THURSDAY(11, 'unspecified'), null),
      'الصبح': botReply('', THURSDAY(11, 'morning'), null),
      'خلاص 11 بالليل': botReply('', THURSDAY(11, 'night'), null),
      // The turn that matters: the model left the day out, as the prompt allows ("خليها 7")
      '7 بالليل': botReply(
        '',
        { day_type: 'none', weekday: null, day_of_month: null, month: null, year: null, hour: 7, minute: null, period: 'night', needs_team_check: false },
        null
      ),
    })
    const { say, appointmentAt } = await visitor((seeded) => openEveryDay(seeded, '12:00', '22:00'))
    for (const message of [NAME, '1234', '01097654189', 'التجمع', 'ايه المواعيد المتاحه']) await say(message)

    const afterTheDay: string[] = []
    for (const message of ['الخميس الساعة 11', 'الصبح', 'خلاص 11 بالليل']) afterTheDay.push(await say(message))
    expect(await appointmentAt()).toEqual([null])

    const booked = await say('7 بالليل')
    afterTheDay.push(booked)

    expect(booked).toBe(APPOINTMENT.bookedConfirmed.replace('{time}', 'الخميس 22 أكتوبر الساعة 7:00 مساءً'))
    expect(await appointmentAt()).toEqual(['2026-10-22T16:00:00.000Z'])
    // Thursday was never asked for again once it was given
    for (const reply of afterTheDay) {
      expect(reply).not.toContain(APPOINTMENT.askTime)
      expect(reply).not.toContain('يوم إيه')
    }
  })

  it('keeps a day given without a time, asks only for the time, and books it when the time comes', async () => {
    chatModel({
      [`${NAME} 01097654189`]: botReply('أهلاً يا مصطفى.', null, { name: NAME, phone: '01097654189' }),
      'عايز أحجز يوم الخميس': botReply('', THURSDAY(null, 'unspecified'), null),
      '7 بالليل': botReply('', { day_type: 'none', hour: 7, period: 'night' }, null),
    })
    const { say, appointmentAt } = await visitor((seeded) => openEveryDay(seeded, '12:00', '22:00'))
    await say(`${NAME} 01097654189`)

    const asked = await say('عايز أحجز يوم الخميس')
    expect(asked).toContain('الخميس')
    expect(asked).not.toContain(APPOINTMENT.askTime)
    expect(asked).not.toContain('يوم إيه')
    expect(await appointmentAt()).toEqual([null])

    expect(await say('7 بالليل')).toBe(APPOINTMENT.bookedConfirmed.replace('{time}', 'الخميس 22 أكتوبر الساعة 7:00 مساءً'))
  })

  // Frozen eval, AM03, 18 October 2026: once day-only reports were allowed,
  // "بكرة بالليل" was booked at 9 PM, an hour the visitor never said
  it('asks the hour for a part of the day alone, keeps the part of the day, and books when the hour comes', async () => {
    chatModel({
      [`${NAME} 01097654189`]: botReply('أهلاً يا مصطفى.', null, { name: NAME, phone: '01097654189' }),
      'ينفع بكرة بالليل؟': botReply('', { day_type: 'tomorrow', period: 'night' }, null),
      'الساعة 9': botReply('', { day_type: 'none', hour: 9, period: 'unspecified' }, null),
    })
    const { say, appointmentAt } = await visitor((seeded) => openEveryDay(seeded, '08:00', '22:00'))
    await say(`${NAME} 01097654189`)

    expect(await say('ينفع بكرة بالليل؟')).toBe(APPOINTMENT.askHour.replace('{day}', 'الاثنين 19 أكتوبر'))
    expect(await appointmentAt()).toEqual([null])
    // 9 alone could be either at a clinic open 8 to 10: "بالليل" settles it
    expect(await say('الساعة 9')).toBe(APPOINTMENT.bookedConfirmed.replace('{time}', 'الاثنين 19 أكتوبر الساعة 9:00 مساءً'))
    expect(await appointmentAt()).toEqual(['2026-10-19T18:00:00.000Z'])
  })

  // "عندكم حاجة الساعة 5؟" then "الثلاثاء": the 5 has its evidence in the turn it arrived in
  it('holds a time said before the day, names it in the question, and books it with the day', async () => {
    chatModel({
      [`${NAME} 01097654189`]: botReply('أهلاً يا مصطفى.', null, { name: NAME, phone: '01097654189' }),
      'عندكم حاجة الساعة 5 العصر؟': botReply('', { day_type: 'none', hour: 5, period: 'afternoon' }, null),
      'الثلاثاء': botReply('', { day_type: 'weekday', weekday: 'tuesday' }, null),
    })
    const { say, appointmentAt } = await visitor((seeded) => openEveryDay(seeded, '12:00', '22:00'))
    await say(`${NAME} 01097654189`)

    // What is held is named: a visitor skimming the question sees the 5 it goes with
    expect(await say('عندكم حاجة الساعة 5 العصر؟')).toBe(APPOINTMENT.askDayAt.replace('{time}', '5:00 مساءً'))
    expect(await say('الثلاثاء')).toBe(APPOINTMENT.bookedConfirmed.replace('{time}', 'الثلاثاء 20 أكتوبر الساعة 5:00 مساءً'))
    expect(await appointmentAt()).toEqual(['2026-10-20T14:00:00.000Z'])
  })

  it('takes back the day, not the time, when the day is the one the clinic is closed', async () => {
    chatModel({
      [`${NAME} 01097654189`]: botReply('أهلاً يا مصطفى.', null, { name: NAME, phone: '01097654189' }),
      'الجمعة الساعة 7 بالليل': botReply('', { day_type: 'weekday', weekday: 'friday', hour: 7, period: 'night' }, null),
      'طب السبت': botReply('', { day_type: 'weekday', weekday: 'saturday', period: 'unspecified' }, null),
    })
    const { say, appointmentAt } = await visitor(closedOnFriday)
    await say(`${NAME} 01097654189`)

    expect(await say('الجمعة الساعة 7 بالليل')).toBe(
      APPOINTMENT.closedDay.replace('{day}', 'الجمعة').replace('{openDays}', 'السبت والأحد والاثنين والثلاثاء والأربعاء والخميس')
    )
    // Saturday 24 October at the 7 PM asked for with Friday
    expect(await say('طب السبت')).toBe(APPOINTMENT.bookedConfirmed.replace('{time}', 'السبت 24 أكتوبر الساعة 7:00 مساءً'))
    expect(await appointmentAt()).toEqual(['2026-10-24T16:00:00.000Z'])
  })
})
