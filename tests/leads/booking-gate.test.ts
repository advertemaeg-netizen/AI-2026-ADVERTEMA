import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ar from '../../messages/ar.json'
import { HELD_REQUEST_INSTRUCTIONS } from '@/lib/ai/appointment'
import { geminiText, mockGemini, seedClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply, lastVisitorMessage, newVisitorId, openEveryDay, sendVisitorMessage } from './webhook'

/**
 * The model proposes; code decides. Each case here is something the demo
 * widget did on its first day of real testing (12 October 2026), with the
 * model's own words from that day as the stand-in model's reply.
 */

const APPOINTMENT = ar.botReplies.appointment
const CONTACT = ar.botReplies.contact

// Monday 5 October 2026, 12:00 in Cairo (UTC+3)
const NOW = '2026-10-05T09:00:00.000Z'
const TOMORROW_7PM = '2026-10-06T16:00:00.000Z'
const TOMORROW_7PM_TEXT = 'الثلاثاء 6 أكتوبر الساعة 7:00 مساءً'
const AT_7_TOMORROW = { day_type: 'tomorrow', hour: 7, period: 'evening' }

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
})
afterEach(() => {
  vi.useRealTimers()
})

/** The chat model answers each visitor message with what `script` holds for it */
function chatModel(script: Record<string, Response | ((call: GeminiCall) => Response)>) {
  mockGemini((call: GeminiCall) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    if (call.kind === 'analysis') return geminiText(JSON.stringify(analyseTranscript(call)))
    const answer = script[lastVisitorMessage(call)]
    if (!answer) throw new Error(`The test's chat model has no answer for "${lastVisitorMessage(call)}"`)
    return typeof answer === 'function' ? answer(call) : answer.clone()
  })
}

/** Whether the model was told a time from earlier is held and may be booked on this message */
const toldHeld = (call: GeminiCall) =>
  ((call.body.systemInstruction as { parts?: { text?: string }[] }).parts?.[0]?.text ?? '').includes(HELD_REQUEST_INSTRUCTIONS)

type Lead = {
  name: string | null
  phone: string | null
  status: string
  appointment_at: string | null
  appointment_confirmed: boolean
  ai_appointment: { at: string; pending?: boolean } | null
  ai_extracted_data: Record<string, unknown> | null
}

/**
 * A clinic open noon to 10 PM that asks for a full name (the rule these
 * tests check: two parts, one re-ask, never a loop), and one visitor talking to it
 */
async function visitor() {
  const seeded = await seedClient({ nameStrictness: 'two_parts' })
  await openEveryDay(seeded, '12:00', '22:00')
  const visitorId = newVisitorId()
  let conversationId: string | undefined
  const say = async (message: string) => {
    const { status, body } = await sendVisitorMessage(seeded.channelId, message, { visitorId, conversationId })
    expect(status).toBe(200)
    conversationId = body.conversationId as string
    return body.reply as string
  }
  const leads = async () => {
    const { data, error } = await seeded.supabase
      .from('leads')
      .select('name, phone, status, appointment_at, appointment_confirmed, ai_appointment, ai_extracted_data')
      .eq('client_id', seeded.clientId)
      .returns<Lead[]>()
    if (error) throw new Error(error.message)
    return data
  }
  const needsHuman = async () => {
    const { data } = await seeded.supabase
      .from('conversations')
      .select('needs_human_since, needs_human_reason')
      .eq('id', conversationId!)
      .single<{ needs_human_since: string | null; needs_human_reason: string | null }>()
    return data!
  }
  return { say, leads, needsHuman }
}

const instant = (value: string | null) => (value ? new Date(value).toISOString() : null)

describe('a phone number is checked before the reply, not after it', () => {
  it('does not tell the visitor a number arrived when it is not a phone number, and stores nothing', async () => {
    chatModel({
      'عايز أحجز': botReply('تمام 😊 ممكن أعرف اسمك؟'),
      '879995233130': botReply('تمام يا م، رقمك وصل. تحب تحجز زراعة الأسنان في فرع المعادي ولا التجمع؟', null, {
        name: null,
        phone: '879995233130',
      }),
    })
    const { say, leads } = await visitor()
    await say('عايز أحجز')

    const reply = await say('879995233130')

    expect(reply).toBe(CONTACT.phoneInvalid)
    expect(reply).not.toContain('وصل')
    expect((await leads()).map((lead) => lead.phone).filter(Boolean)).toEqual([])
  })

  it('answers "did you save my number?" from the lead row, not from the chat', async () => {
    chatModel({
      'عايز أحجز': botReply('تمام 😊 ممكن رقم موبايلك؟'),
      '879995233130': botReply('تمام، رقمك وصل.', null, { phone: '879995233130' }),
      // The demo bot's own answer that day, word for word
      'سجلت رقم تليفوني ؟': botReply('أيوه، الرقم اللي بعتّه هو 879995233130. بس للتوضيح، الفريق هيأكدلك الميعاد.'),
      'غيره خليه 01097365130': botReply('تمام.', null, { phone: '01097365130' }),
      'سجلت رقمي؟': botReply('أيوه، رقمك عندنا {{saved_phone}}.'),
    })
    const { say, leads } = await visitor()
    await say('عايز أحجز')
    await say('879995233130')

    const asked = await say('سجلت رقم تليفوني ؟')
    expect(asked).not.toContain('879995233130')
    expect(asked).toContain(CONTACT.noPhoneOnRecord)

    await say('غيره خليه 01097365130')
    expect((await leads()).map((lead) => lead.phone)).toEqual(['+201097365130'])
    expect(await say('سجلت رقمي؟')).toBe('أيوه، رقمك عندنا 01097365130.')
  })

  it('stores a valid number as E.164 before the reply, whatever shape it was typed in', async () => {
    chatModel({ 'عايز أحجز، رقمي ٠١٠٠ ٢٨٤ ٧٩٠١': botReply('تمام. رقمك عندنا {{saved_phone}}.') })
    const { say, leads } = await visitor()

    // The lead row already holds it when the reply is written
    expect(await say('عايز أحجز، رقمي ٠١٠٠ ٢٨٤ ٧٩٠١')).toBe('تمام. رقمك عندنا 01002847901.')
    expect((await leads()).map((lead) => lead.phone)).toEqual(['+201002847901'])
  })

  it('stops asking after two numbers that are not one, and puts the conversation in front of a person', async () => {
    const wrong = (digits: string) => botReply('تمام، رقمك وصل.', null, { phone: digits })
    chatModel({ '010': wrong('010'), '9856546': wrong('9856546'), '879995233130': wrong('879995233130') })
    const { say, needsHuman } = await visitor()

    expect(await say('010')).toBe(CONTACT.phoneInvalid)
    expect(await needsHuman()).toMatchObject({ needs_human_since: null })
    expect(await say('9856546')).toBe(CONTACT.phoneGiveUp)
    expect((await needsHuman()).needs_human_since).not.toBeNull()
    // Still not a number; still no claim that it arrived, and no third request for it
    expect(await say('879995233130')).toBe(CONTACT.phoneGiveUp)
  })
})

describe('a name is checked, with one re-ask and never a loop', () => {
  it('takes a short name on the next message and flags the lead, without asking before a time is held', async () => {
    chatModel({
      'عايز أحجز، رقمي 01002847901': botReply('تمام 😊 ممكن أعرف اسمك؟'),
      'اسمي م': botReply('تمام يا م 😊', null, { name: 'م' }),
      'م': botReply('تمام يا م. تحب الميعاد إمتى؟', null, { name: 'م' }),
    })
    const { say, leads } = await visitor()
    await say('عايز أحجز، رقمي 01002847901')

    // No time is held: code does not ask about the name yet (the booking
    // order), and the name is not accepted on this message either
    expect(await say('اسمي م')).not.toContain(CONTACT.nameAsk)
    expect((await leads())[0].name).toBeNull()

    // The second answer is accepted as it is: the model's reply goes through
    expect(await say('م')).toBe('تمام يا م. تحب الميعاد إمتى؟')
    const [lead] = await leads()
    expect(lead.name).toBe('م')
    expect(lead.ai_extracted_data).toMatchObject({ name_incomplete: true })
  })

  // The eval, case NM01, 13 October 2026: the real model, told the name was
  // on record, went on asking for it — its words here are the ones it used.
  // The test above could not see this: its stand-in model stops asking.
  it('does not send the model\'s request for the name once the name is on record, and asks for what is next', async () => {
    const asksAgain = () => botReply('محتاج اسمك بالكامل لو سمحت.', null, { name: 'م' })
    chatModel({
      'عايز أحجز، رقمي 01002847901': botReply('تمام، محتاج اسمك بالكامل لو سمحت.'),
      'اسمي م': asksAgain,
      'م': asksAgain,
      'م م': asksAgain,
    })
    const { say, leads } = await visitor()
    await say('عايز أحجز، رقمي 01002847901')
    // No time is held, so code does not ask about the name yet (the booking order)
    expect(await say('اسمي م')).not.toContain(CONTACT.nameAsk)

    // Accepted as given: greeted by it, and asked for the day and time, the
    // next thing the booking needs (the number is on record)
    const moved = `${CONTACT.nameAck.replace('{name}', 'م')}\n${APPOINTMENT.askTime}`
    expect(await say('م')).toBe(moved)
    // And on the message after it, whatever the model writes
    expect(await say('م م')).toBe(moved)
    const [lead] = await leads()
    expect(lead.name).toBe('م')
    expect(lead.ai_extracted_data).toMatchObject({ name_incomplete: true })
  })
})

describe('no appointment without a name and a valid phone number', () => {
  it('keeps the time as a request, claims nothing, and asks for the first thing missing', async () => {
    chatModel({ 'عايز أحجز بكرة الساعة 7 مساءً': botReply('تمام، حجزتلك {{appointment}}.', AT_7_TOMORROW) })
    const { say, leads } = await visitor()

    const reply = await say('عايز أحجز بكرة الساعة 7 مساءً')

    // One thing per message, the name first (the booking order)
    expect(reply).toBe(APPOINTMENT.needDetails.replace('{time}', TOMORROW_7PM_TEXT).replace('{missing}', APPOINTMENT.missingName))
    expect(reply).not.toContain('حجزتلك')
    expect(reply).not.toContain(APPOINTMENT.confirmed)
    const [lead] = await leads()
    expect(lead).toMatchObject({ status: 'new', appointment_at: null, appointment_confirmed: false })
    expect(lead.ai_appointment).toMatchObject({ pending: true })
    expect(instant(lead.ai_appointment!.at)).toBe(TOMORROW_7PM)
  })

  // eval case LC02: the booking and a one-word name in one message, then
  // another question. Code books the held time on that message with nothing
  // reported, so code decides, and the model's reply — written without
  // knowing — is not sent: only its answer to the question is.
  it('books the requested time on the next message, whatever it is about, once the details are there', async () => {
    const told: boolean[] = []
    chatModel({
      'عايز أحجز زراعة بكرة 7 مساءً، أنا سامح والرقم 01554108276': (call) => {
        told.push(toldHeld(call))
        return botReply('تمام يا سامح، حجزتلك {{appointment}}.', AT_7_TOMORROW, { name: 'سامح', phone: '01554108276' })
      },
      'والتأمين بيغطي؟': (call) => {
        told.push(toldHeld(call))
        return botReply(
          'ابعت صورة الكارنيه والفريق هيرد عليك بالتغطية. والميعاد اللي طلبته مش متاح، تحب وقت تاني؟',
          null,
          null,
          'ابعت صورة الكارنيه والفريق هيرد عليك بالتغطية.'
        )
      },
    })
    const { say, leads } = await visitor()

    const first = await say('عايز أحجز زراعة بكرة 7 مساءً، أنا سامح والرقم 01554108276')
    expect(first).toBe(`عشان أثبّت الحجز يوم ${TOMORROW_7PM_TEXT} محتاج اسمك بالكامل.`)
    expect((await leads())[0]).toMatchObject({ appointment_at: null, phone: '+201554108276', name: null })

    const second = await say('والتأمين بيغطي؟')
    // Told before it answered that the held time may be booked on this message
    expect(told).toEqual([false, true])
    // The question is answered, and the appointment is stated from the record
    expect(second).toBe(
      `ابعت صورة الكارنيه والفريق هيرد عليك بالتغطية.\n${APPOINTMENT.bookedConfirmed.replace('{time}', TOMORROW_7PM_TEXT)}`
    )
    expect(second).not.toContain('مش متاح')
    const [lead] = await leads()
    expect(lead).toMatchObject({ name: 'سامح', status: 'appointment_booked', appointment_confirmed: true })
    expect(instant(lead.appointment_at)).toBe(TOMORROW_7PM)
    expect(lead.ai_appointment).not.toHaveProperty('pending')
    expect(lead.ai_extracted_data).toMatchObject({ name_incomplete: true })
  })

  // The other direction of the same turn: code refuses the held time, and the
  // model, which reported nothing, wrote that it was booked
  it('does not send the model\'s booking when code drops the held time on the next message', async () => {
    chatModel({
      'عايز أحجز بكرة الساعة 7 مساءً، رقمي 01002847901': botReply('تمام، حجزتلك {{appointment}}.', AT_7_TOMORROW, { phone: '01002847901' }),
      'أنا كريم سامي': botReply('تمام يا كريم، اتسجل الميعاد ✅', null, { name: 'كريم سامي' }, null),
    })
    const { say, leads } = await visitor()
    await say('عايز أحجز بكرة الساعة 7 مساءً، رقمي 01002847901')
    expect((await leads())[0].ai_appointment).toMatchObject({ pending: true })

    // The visitor comes back after the time has gone
    vi.setSystemTime(new Date('2026-10-07T09:00:00.000Z'))
    const reply = await say('أنا كريم سامي')

    expect(reply).toBe(APPOINTMENT.past)
    expect(reply).not.toContain('اتسجل')
    expect((await leads())[0]).toMatchObject({ appointment_at: null, ai_appointment: null })
  })

  it('books at once when the name and the number come first', async () => {
    chatModel({
      'كريم سامي، 01002847901': botReply('أهلاً يا كريم.', null, { name: 'كريم سامي', phone: '01002847901' }),
      'بكرة الساعة 7 مساءً': botReply('حجزتلك {{appointment}}.', AT_7_TOMORROW, null),
    })
    const { say, leads } = await visitor()
    await say('كريم سامي، 01002847901')

    expect(await say('بكرة الساعة 7 مساءً')).toBe(APPOINTMENT.bookedConfirmed.replace('{time}', TOMORROW_7PM_TEXT))
    const [lead] = await leads()
    expect(lead).toMatchObject({ name: 'كريم سامي', phone: '+201002847901', status: 'appointment_booked' })
    expect(lead.ai_extracted_data).toMatchObject({ name_incomplete: false })
  })

  // The frozen eval, case BK04, 12 October 2026: the model asked for a
  // four-part name under a booking the system had just confirmed
  it('lets the record speak alone when the model reports an appointment and writes a reply against it', async () => {
    chatModel({
      'كريم سامي، 01002847901': botReply('أهلاً يا كريم.', null, { name: 'كريم سامي', phone: '01002847901' }),
      'بكرة الساعة 7 مساءً': botReply('تمام، محتاج اسمك الرباعي الأول عشان نكمل الحجز.', AT_7_TOMORROW, null),
    })
    const { say, leads } = await visitor()
    await say('كريم سامي، 01002847901')

    expect(await say('بكرة الساعة 7 مساءً')).toBe(APPOINTMENT.bookedConfirmed.replace('{time}', TOMORROW_7PM_TEXT))
    expect(instant((await leads())[0].appointment_at)).toBe(TOMORROW_7PM)
  })

  it('does not book on a number that was rejected, and hands the request to the team once it stops asking', async () => {
    chatModel({
      'أنا كريم سامي': botReply('أهلاً يا كريم.', null, { name: 'كريم سامي' }),
      '0100': botReply('تمام، رقمك وصل.', null, { phone: '0100' }),
      '879995233130': botReply('تمام، رقمك وصل.', null, { phone: '879995233130' }),
      'احجزلي بكرة الساعة 7 مساءً': botReply('حجزتلك {{appointment}}.', AT_7_TOMORROW, null),
    })
    const { say, leads, needsHuman } = await visitor()
    await say('أنا كريم سامي')
    await say('0100')
    await say('879995233130')

    const reply = await say('احجزلي بكرة الساعة 7 مساءً')

    expect(reply).toBe(APPOINTMENT.needDetailsHandoff.replace('{time}', TOMORROW_7PM_TEXT))
    expect((await leads()).map((lead) => lead.appointment_at)).toEqual([null])
    expect((await needsHuman()).needs_human_since).not.toBeNull()
  })
})

describe('a time the clinic is closed at', () => {
  // The demo widget: "هسجل طلبك لزراعة الأسنان في المعادي الثلاثاء 13 أكتوبر الساعة 5:00 صباحاً ✅ موعدك مؤكد"
  it('is refused with the hours of that day: 5 in the morning at a clinic that opens at noon', async () => {
    chatModel({
      'كريم سامي، 01002847901': botReply('أهلاً يا كريم.', null, { name: 'كريم سامي', phone: '01002847901' }),
      'بكرة الساعة 5 الفجر': botReply('تمام، هسجل طلبك لزراعة الأسنان في المعادي {{appointment}}.', {
        day_type: 'tomorrow',
        hour: 5,
        period: 'morning',
      }),
    })
    const { say, leads } = await visitor()
    await say('كريم سامي، 01002847901')

    const reply = await say('بكرة الساعة 5 الفجر')

    expect(reply).toBe('الميعاد ده برّه مواعيد العمل: يوم الثلاثاء بنشتغل من 12:00 ظهراً لـ 10:00 مساءً. تحب ساعة تانية؟')
    expect(reply).not.toContain(APPOINTMENT.confirmed)
    expect((await leads()).map((lead) => [lead.status, lead.appointment_at])).toEqual([['new', null]])
  })

  // The demo widget: "25 يناير 2026" was booked for 25 January 2027
  it('refuses a date that has gone instead of moving it to next year', async () => {
    chatModel({
      'كريم سامي، 01002847901': botReply('أهلاً يا كريم.', null, { name: 'كريم سامي', phone: '01002847901' }),
      'عايز أحجز يوم 25 يناير 2026 الساعة 5 مساءً': botReply('حجزتلك {{appointment}}.', {
        day_type: 'date',
        day_of_month: 25,
        month: 1,
        year: 2026,
        hour: 5,
        period: 'afternoon',
      }),
    })
    const { say, leads } = await visitor()
    await say('كريم سامي، 01002847901')

    expect(await say('عايز أحجز يوم 25 يناير 2026 الساعة 5 مساءً')).toBe(APPOINTMENT.past)
    expect((await leads()).map((lead) => lead.appointment_at)).toEqual([null])
  })
})
