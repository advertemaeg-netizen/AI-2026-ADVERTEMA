import { describe, expect, it } from 'vitest'
import ar from '../../messages/ar.json'
import { formatAppointment } from '@/lib/ai/appointment'
import { geminiText, mockGemini, seedClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, lastVisitorMessage, newVisitorId, openEveryDay, sendVisitorMessage } from './webhook'

/**
 * AN EMPTY REPLY IS VALID WHENEVER SOMETHING ELSE IS SHOWN. The model is told
 * its reply is not shown on turns where code writes the message, and it
 * sometimes returns it empty; the parser took that as a failure. Confirmed
 * from the container log on 22 October 2026: «The model returned no reply»,
 * twice, each time sending the visitor the service-down message (conversations
 * ea0d1752 and 815fc0b3). The third time it happened, and the first proof.
 */

const T = ar.botReplies.appointment
const NUMBER = '01012345678'

/** The chat model's raw answer, every field as given */
const answer = (fields: { reply?: string; appointment?: Record<string, unknown> | null; contact?: Record<string, unknown> | null; other_answer?: string | null }) =>
  geminiText(JSON.stringify({ contact: null, appointment: null, branch: null, other_answer: null, reply: '', ...fields }))

function chatModel(script: Record<string, Response>) {
  mockGemini((call: GeminiCall) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    if (call.kind === 'analysis') return geminiText(JSON.stringify(analyseTranscript(call)))
    const response = script[lastVisitorMessage(call)]
    if (!response) throw new Error(`The test's chat model has no answer for "${lastVisitorMessage(call)}"`)
    return response.clone()
  })
}

async function visitor() {
  const seeded = await seedClient()
  await openEveryDay(seeded)
  const visitorId = newVisitorId()
  let conversationId: string | undefined
  const say = async (message: string) => {
    const { status, body } = await sendVisitorMessage(seeded.channelId, message, { visitorId, conversationId })
    expect(status).toBe(200)
    conversationId = body.conversationId as string
    return body as { reply: string; fallback?: true }
  }
  const lastBotMessage = async () => {
    const { data } = await seeded.supabase
      .from('messages')
      .select('content, metadata')
      .eq('conversation_id', conversationId!)
      .eq('role', 'assistant')
      .order('created_at', { ascending: false })
      .limit(1)
      .single<{ content: string; metadata: Record<string, unknown> }>()
    return data!
  }
  const appointmentAt = async () => {
    const { data } = await seeded.supabase.from('leads').select('appointment_at').eq('client_id', seeded.clientId).returns<{ appointment_at: string | null }[]>()
    return data?.[0]?.appointment_at ?? null
  }
  return { say, lastBotMessage, appointmentAt }
}

describe('an empty reply from the model', () => {
  it('is no failure on the turns that complete a held booking: code asks for the number, then books', async () => {
    chatModel({
      'عايز أحجز بكرة الساعة 5 العصر': answer({ appointment: { day_type: 'tomorrow', hour: 5, period: 'afternoon' } }),
      // The completion turns: the model reports the detail and, told code
      // writes the message, leaves its reply empty with no appointment
      'كريم مصطفى': answer({ contact: { name: 'كريم مصطفى', phone: null } }),
      [NUMBER]: answer({ contact: { name: null, phone: NUMBER } }),
    })
    const { say, lastBotMessage, appointmentAt } = await visitor()
    const held = await say('عايز أحجز بكرة الساعة 5 العصر')
    expect(held.fallback).toBeUndefined()

    const named = await say('كريم مصطفى')
    expect(named.fallback).toBeUndefined()
    expect(named.reply).toContain(T.missingPhone)

    const completed = await say(NUMBER)
    expect(completed.fallback).toBeUndefined()
    const at = await appointmentAt()
    expect(at).not.toBeNull()
    expect(completed.reply).toBe(T.bookedConfirmed.replace('{time}', formatAppointment(at!, 'ar')))
    expect((await lastBotMessage()).metadata).not.toHaveProperty('fallback')
  })

  it('sends the answer the model put in other_answer when it left the reply empty', async () => {
    // Conversation ea0d1752, 21 October: «سعر الكشف كام» answered as the service-down message
    chatModel({ 'سعر الكشف كام': answer({ other_answer: 'سعر الكشف 380 جنيه.' }) })
    const { say } = await visitor()

    expect(await say('سعر الكشف كام')).toMatchObject({ reply: 'سعر الكشف 380 جنيه.' })
  })

  it('is a failure only when nothing at all is left to send, and the model\'s raw answer is kept with the fallback', async () => {
    chatModel({ 'أهلاً': answer({}) })
    const { say, lastBotMessage } = await visitor()

    expect(await say('أهلاً')).toMatchObject({ fallback: true })
    const stored = await lastBotMessage()
    expect(stored.metadata).toMatchObject({
      fallback: 'ai_unavailable',
      error: 'The model returned no reply',
      raw: JSON.stringify({ contact: null, appointment: null, branch: null, other_answer: null, reply: '' }),
    })
  })
})
