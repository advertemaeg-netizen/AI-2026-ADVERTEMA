import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ar from '../../messages/ar.json'
import en from '../../messages/en.json'
import {
  APPOINTMENT_INSTRUCTIONS,
  HELD_REQUEST_INSTRUCTIONS,
  appointmentLine,
  appointmentRequestSchema,
  formatAppointment,
  mergeDraft,
  narrowDraft,
} from '@/lib/ai/appointment'
import { buildSystemPrompt } from '@/lib/ai/bot'
import { BOOKING_ORDER_INSTRUCTIONS } from '@/lib/ai/booking-order'
import { composeReply } from '@/lib/ai/compose'
import { describeContact, EMPTY_CONTACT } from '@/lib/ai/contact'
import type { BotSettingsInput } from '@/lib/types/bot-settings'
import { geminiText, mockGemini, seedClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply, lastVisitorMessage, newVisitorId, openEveryDay, sendVisitorMessage } from './webhook'

/**
 * The booking order (src/lib/ai/booking-order.ts) and the code that holds to
 * it: the appointment first, then the name, then the mobile number, one thing
 * per message, each question asked by code once the time is held.
 *
 * The visitor writes English here: the checks read it as they read Arabic
 * ("tomorrow", "7 pm", a name in any script), and the expected replies are
 * built from messages/ar.json rather than typed.
 */

const APPOINTMENT = ar.botReplies.appointment
const CONTACT = ar.botReplies.contact

// Monday 5 October 2026, 12:00 in Cairo (UTC+3)
const NOW = '2026-10-05T09:00:00.000Z'
const TOMORROW_7PM = '2026-10-06T16:00:00.000Z'
const TOMORROW_7PM_TEXT = formatAppointment(TOMORROW_7PM, 'ar')
const AT_7_TOMORROW = { day_type: 'tomorrow', hour: 7, period: 'evening' }
const needs = (field: 'missingName' | 'missingPhone') =>
  APPOINTMENT.needDetails.replace('{time}', TOMORROW_7PM_TEXT).replace('{missing}', APPOINTMENT[field])

const SETTINGS: BotSettingsInput = {
  system_prompt: 'You are the clinic assistant.',
  tone: 'friendly',
  language: 'ar',
  temperature: 0.7,
  max_response_length: 500,
  welcome_message: 'Hello',
  fallback_message: 'Sorry',
  service_unavailable_message: 'Down',
  lead_qualification_enabled: true,
  auto_confirm_appointments: true,
  business_hours: null,
}
const CLIENT = { name: 'Clinic', industry: null, description: null }

describe('the booking order is injected by code, after the booking JSON instructions', () => {
  const prompt = (settings: Partial<BotSettingsInput> = {}, held = false) =>
    buildSystemPrompt(CLIENT, { ...SETTINGS, ...settings }, [], new Date(NOW), EMPTY_CONTACT, held)

  it('comes right after the appointment instructions, with the held request and the record below it', () => {
    const text = prompt({}, true)
    const order = text.indexOf(BOOKING_ORDER_INSTRUCTIONS)
    expect(order).toBeGreaterThan(-1)
    expect(text.indexOf(`${APPOINTMENT_INSTRUCTIONS}\n\n${BOOKING_ORDER_INSTRUCTIONS}`)).toBeGreaterThan(-1)
    expect(text.indexOf(HELD_REQUEST_INSTRUCTIONS)).toBeGreaterThan(order)
    expect(text.indexOf(describeContact(EMPTY_CONTACT))).toBeGreaterThan(order)
  })

  it('comes after the client\'s own prompt, so its last line has something to overrule', () => {
    const text = prompt()
    expect(text.indexOf(SETTINGS.system_prompt)).toBeLessThan(text.indexOf(BOOKING_ORDER_INSTRUCTIONS))
  })

  it('no longer tells the model to ask for the name and phone number itself', () => {
    expect(prompt()).not.toMatch(/ask for their name and phone number/i)
  })

  it('is not there when the bot collects no leads, like the rest of the booking rules', () => {
    expect(prompt({ lead_qualification_enabled: false })).not.toContain(BOOKING_ORDER_INSTRUCTIONS)
  })

  it('holds back the branch and the service lines: four steps, numbered 1 to 4', () => {
    const steps = BOOKING_ORDER_INSTRUCTIONS.split('\n').filter((line) => /^\d\. /.test(line))
    expect(steps.map((line) => line[0])).toEqual(['1', '2', '3', '4'])
    expect(BOOKING_ORDER_INSTRUCTIONS).toHaveLength(609)
  })
})

describe('the model reports what the latest message says, and no more', () => {
  // The evidence rule drops a restated part anyway; the draft holds it
  it('is not told to restate the parts of the request earlier messages gave', () => {
    expect(APPOINTMENT_INSTRUCTIONS).not.toMatch(/report the whole request/i)
    expect(APPOINTMENT_INSTRUCTIONS).toMatch(/only what the latest message/i)
  })

  it('is told a closed day keeps the time, as a refused time keeps the day', () => {
    expect(APPOINTMENT_INSTRUCTIONS).toMatch(/closed[^.]*keeps the time/i)
  })

  it('is told to report a name or number given before it was asked for', () => {
    expect(APPOINTMENT_INSTRUCTIONS).toMatch(/before (?:it was|they were) asked for/i)
  })

  it('is not told to ask for what is still missing of a held request: the system asks', () => {
    expect(HELD_REQUEST_INSTRUCTIONS).not.toMatch(/what you still need/i)
  })
})

describe('one thing per message, in the order of the instruction', () => {
  const at = TOMORROW_7PM

  it('asks for the name alone when both are missing, and for the number once the name is there', () => {
    expect(appointmentLine({ status: 'needs_details', at, missing: ['name', 'phone'], handoff: false }, 'ar')).toBe(needs('missingName'))
    expect(appointmentLine({ status: 'needs_details', at, missing: ['phone'], handoff: false }, 'ar')).toBe(needs('missingPhone'))
  })

  it('asks for the day alone when nothing of the appointment is known', () => {
    expect(appointmentLine({ status: 'incomplete', missing: ['day', 'time'], day: null, time: null }, 'en')).toBe(en.botReplies.appointment.askTime)
    expect(en.botReplies.appointment.askTime).not.toMatch(/time/i)
    expect(appointmentLine({ status: 'none' }, 'en')).not.toMatch(/time/i)
  })

  it('asks one question when a time has gone', () => {
    expect(appointmentLine({ status: 'past' }, 'en').match(/\?/g)).toHaveLength(1)
  })

  it('asks for the day and time before the number, when the name is what the visitor just gave', () => {
    const compose = (time: boolean) =>
      composeReply({
        template: 'What is your full name please?',
        outcome: { status: 'none' },
        events: { name: 'stored', phone: 'none' },
        record: { name: 'Karim Samy', phone: null },
        visitorMessages: ['Karim Samy'],
        language: 'en',
        known: { name: 'Karim Samy', phone: null, phoneGivenUp: false, time },
      })
    expect(compose(false)).toBe(`${en.botReplies.contact.nameAck.replace('{name}', 'Karim')}\n${en.botReplies.appointment.askTime}`)
    expect(compose(true)).toBe(`${en.botReplies.contact.nameAck.replace('{name}', 'Karim')}\n${en.botReplies.contact.phoneAsk}`)
  })
})

describe('a refusal takes back the part refused, and keeps the rest', () => {
  const now = new Date(NOW)
  const request = (fields: Record<string, unknown>) => appointmentRequestSchema.parse({ period: 'unspecified', ...fields })

  it('keeps the time when the date asked for has gone, and takes the date back', () => {
    const gone = request({ day_type: 'date', day_of_month: 25, month: 1, year: 2026, hour: 5, period: 'afternoon' })
    const draft = narrowDraft(null, gone, { status: 'past' }, now)
    expect(draft?.day).toBeNull()
    expect(draft?.time).toEqual({ hour: 5, minute: null, period: 'afternoon' })
  })

  it('keeps the day when a time today has gone, and takes the time back', () => {
    const draft = narrowDraft(null, request({ day_type: 'today', hour: 9, period: 'morning' }), { status: 'past' }, now)
    expect(draft?.time).toBeNull()
    expect(mergeDraft(draft, request({ hour: 5, period: 'afternoon' }))).toMatchObject({ day_type: 'date', day_of_month: 5, hour: 5 })
  })
})

describe('the questions after the time is held are code\'s', () => {
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

  async function visitor() {
    const seeded = await seedClient()
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
        .select('name, phone, appointment_at, ai_extracted_data')
        .eq('client_id', seeded.clientId)
        .returns<{ name: string | null; phone: string | null; appointment_at: string | null; ai_extracted_data: Record<string, unknown> | null }[]>()
      if (error) throw new Error(error.message)
      return data
    }
    return { say, leads }
  }

  it('asks for the name, then the mobile number, then books: whatever the model writes in between', async () => {
    chatModel({
      'book me tomorrow at 7 pm': botReply('Done, booked {{appointment}}. Your name and number?', AT_7_TOMORROW, null),
      // The model, which used to write this turn, asks for the number its own way
      'Karim Samy': botReply('Thanks Karim! What is your mobile number?', null, { name: 'Karim Samy' }),
      '01002847901': botReply('Thanks, all set.', null, { phone: '01002847901' }),
    })
    const { say, leads } = await visitor()

    expect(await say('book me tomorrow at 7 pm')).toBe(needs('missingName'))
    expect(await say('Karim Samy')).toBe(needs('missingPhone'))
    expect(await say('01002847901')).toBe(APPOINTMENT.bookedConfirmed.replace('{time}', TOMORROW_7PM_TEXT))
    const [lead] = await leads()
    expect(lead).toMatchObject({ name: 'Karim Samy', phone: '+201002847901' })
    expect(new Date(lead.appointment_at!).toISOString()).toBe(TOMORROW_7PM)
  })

  it('answers something else the visitor asked on that turn, then asks for the number', async () => {
    chatModel({
      'book me tomorrow at 7 pm': botReply('', AT_7_TOMORROW, null),
      'Karim Samy, do you take insurance?': botReply('We take MedNet. What is your number?', null, { name: 'Karim Samy' }, 'We take MedNet.'),
    })
    const { say } = await visitor()
    await say('book me tomorrow at 7 pm')

    expect(await say('Karim Samy, do you take insurance?')).toBe(`We take MedNet.\n${needs('missingPhone')}`)
  })

  it('says only what is wrong with a rejected number, not the same question a second time', async () => {
    chatModel({
      'Karim Samy': botReply('Hello Karim.', null, { name: 'Karim Samy' }),
      'book me tomorrow at 7 pm': botReply('', AT_7_TOMORROW, null),
      '0100': botReply('Got it.', null, { phone: '0100' }),
    })
    const { say } = await visitor()
    await say('Karim Samy')
    expect(await say('book me tomorrow at 7 pm')).toBe(needs('missingPhone'))

    expect(await say('0100')).toBe(CONTACT.phoneInvalid)
  })

  it('keeps a name given before the appointment, and asks only for the number once the time is held', async () => {
    chatModel({
      'I am Karim Samy and I want to book': botReply('Hello Karim, which day would suit you?', null, { name: 'Karim Samy' }),
      'tomorrow at 7 pm': botReply('', AT_7_TOMORROW, null),
    })
    const { say } = await visitor()
    await say('I am Karim Samy and I want to book')

    expect(await say('tomorrow at 7 pm')).toBe(needs('missingPhone'))
  })

  it('does not ask about a one-word name before the appointment, and takes it on the next message', async () => {
    chatModel({
      'I am Sameh and I want to book': botReply('Hello Sameh, which day would suit you?', null, { name: 'Sameh' }),
      'tomorrow at 7 pm': botReply('', AT_7_TOMORROW, null),
    })
    const { say, leads } = await visitor()

    expect(await say('I am Sameh and I want to book')).toBe('Hello Sameh, which day would suit you?')
    // Not asked about again at the name step: taken as given (flagged for the team)
    expect(await say('tomorrow at 7 pm')).toBe(needs('missingPhone'))
    expect((await leads())[0]).toMatchObject({ name: 'Sameh' })
  })
})
