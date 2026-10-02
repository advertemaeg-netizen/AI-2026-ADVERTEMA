import { describe, expect, it } from 'vitest'
import { flushAfter, geminiCalls, geminiError, geminiText, mockGemini, seedClient, type GeminiCall } from '../harness/helpers'
import { DEFAULT_SERVICE_UNAVAILABLE_MESSAGE } from '@/lib/types/bot-settings'
import { analyseTranscript, botReply, INTRO_MESSAGE, newVisitorId, sendVisitorMessage } from './webhook'

/** What fetch rejects with when AbortSignal.timeout() fires */
const timeout = () => new DOMException('The operation was aborted due to timeout', 'TimeoutError')

/** The chat model answers with `reply` (which may throw); embeddings are off, the analysis works */
function chatModel(reply: (call: GeminiCall) => Response) {
  mockGemini((call) => {
    if (call.kind === 'embedding') return geminiError(503)
    return call.kind === 'analysis' ? geminiText(JSON.stringify(analyseTranscript(call))) : reply(call)
  })
}

async function assistantMessages(seeded: Awaited<ReturnType<typeof seedClient>>, conversationId: string) {
  const { data } = await seeded.supabase
    .from('messages')
    .select('content')
    .eq('conversation_id', conversationId)
    .eq('role', 'assistant')
  return data!.map((message) => message.content as string)
}

const replyCalls = () => geminiCalls.filter((call) => call.kind === 'reply').length

async function needsHumanSince(seeded: Awaited<ReturnType<typeof seedClient>>, conversationId: string) {
  const { data } = await seeded.supabase.from('conversations').select('needs_human_since').eq('id', conversationId).single()
  return data!.needs_human_since as string | null
}

/** The stored fallback's metadata, after checking the visitor got it as a normal reply */
async function fallbackOf(seeded: Awaited<ReturnType<typeof seedClient>>, body: Record<string, unknown>) {
  expect(body).toMatchObject({ ok: true, fallback: true })
  const { data } = await seeded.supabase
    .from('messages')
    .select('content, metadata')
    .eq('conversation_id', body.conversationId as string)
    .eq('role', 'assistant')
  expect(data).toHaveLength(1)
  expect(data![0].content).toBe(body.reply)
  expect(data![0].metadata).toMatchObject({ fallback: 'ai_unavailable' })
  return data![0].metadata as { reason: string }
}

describe('a failed reply is tried again only when that can help', () => {
  it('answers the visitor once when the first attempt times out', async () => {
    let attempts = 0
    chatModel(() => {
      attempts += 1
      if (attempts === 1) throw timeout()
      return botReply('أهلاً بيك يا أستاذ كريم.')
    })
    const seeded = await seedClient()

    const { status, body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    await flushAfter()

    expect(status).toBe(200)
    expect(body.reply).toBe('أهلاً بيك يا أستاذ كريم.')
    expect(replyCalls()).toBe(2)
    // One reply stored, one message counted: the attempt that timed out left nothing behind
    expect(await assistantMessages(seeded, body.conversationId as string)).toEqual(['أهلاً بيك يا أستاذ كريم.'])
    const { data: subscription } = await seeded.supabase
      .from('client_subscriptions')
      .select('messages_used')
      .eq('client_id', seeded.clientId)
      .single()
    expect(subscription!.messages_used).toBe(1)
  })

  it('does not retry a 429: the fallback goes out at once', async () => {
    chatModel(() => geminiError(429))
    const seeded = await seedClient()

    const { status, body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    await flushAfter()

    expect(status).toBe(200)
    expect(replyCalls()).toBe(1)
    expect(await fallbackOf(seeded, body)).toMatchObject({ reason: 'rate_limited' })
  })

  it('tries a 503 again, with a wait, and answers once the model is back', async () => {
    let attempts = 0
    chatModel(() => {
      attempts += 1
      return attempts < 3 ? geminiError(503) : botReply('أهلاً بيك يا أستاذ كريم.')
    })
    const seeded = await seedClient()

    const { status, body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    await flushAfter()

    expect(status).toBe(200)
    expect(body.reply).toBe('أهلاً بيك يا أستاذ كريم.')
    expect(replyCalls()).toBe(3)
    expect(await assistantMessages(seeded, body.conversationId as string)).toEqual(['أهلاً بيك يا أستاذ كريم.'])
  })

  it('falls back after the second timeout and after the third 503', async () => {
    chatModel(() => {
      throw timeout()
    })
    const timedOut = await seedClient()
    const first = await sendVisitorMessage(timedOut.channelId, INTRO_MESSAGE)
    expect(replyCalls()).toBe(2)
    expect(await fallbackOf(timedOut, first.body)).toMatchObject({ reason: 'timeout' })

    chatModel(() => geminiError(503))
    const overloaded = await seedClient()
    const second = await sendVisitorMessage(overloaded.channelId, INTRO_MESSAGE)
    await flushAfter()
    expect(replyCalls()).toBe(2 + 3)
    expect(await fallbackOf(overloaded, second.body)).toMatchObject({ reason: 'overloaded' })
  })
})

describe('when the AI call fails the visitor is told so and the team is told too', () => {
  it('sends the service-unavailable message instead of an error, uncounted, and marks the conversation', async () => {
    chatModel(() => geminiError(429))
    const seeded = await seedClient()

    const { status, body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    await flushAfter()

    const { data: settings } = await seeded.supabase.rpc('get_bot_settings', { client_id: seeded.clientId })
    expect(status).toBe(200)
    // The service is down: not "I don't have this information"
    expect(settings.service_unavailable_message).toBe(DEFAULT_SERVICE_UNAVAILABLE_MESSAGE)
    expect(settings.service_unavailable_message).not.toBe(settings.fallback_message)
    expect(body).toMatchObject({ ok: true, reply: DEFAULT_SERVICE_UNAVAILABLE_MESSAGE, fallback: true })
    expect(await assistantMessages(seeded, body.conversationId as string)).toEqual([DEFAULT_SERVICE_UNAVAILABLE_MESSAGE])
    // Not an AI reply: it doesn't use up one of the plan's messages
    const { data: subscription } = await seeded.supabase
      .from('client_subscriptions')
      .select('messages_used')
      .eq('client_id', seeded.clientId)
      .single()
    expect(subscription!.messages_used).toBe(0)
    expect(await needsHumanSince(seeded, body.conversationId as string)).not.toBeNull()
  })

  it('uses the message the client wrote', async () => {
    chatModel(() => geminiError(429))
    const seeded = await seedClient()
    const custom = 'النظام واقف دلوقتي. اتصل على 02-25201184.'
    const { error } = await seeded.supabase
      .from('bot_settings')
      .update({ service_unavailable_message: custom })
      .eq('client_id', seeded.clientId)
    expect(error).toBeNull()

    const { body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)

    expect(body.reply).toBe(custom)
  })

  it('keeps the mark through a later AI reply and clears it when a person answers', async () => {
    let down = true
    chatModel(() => (down ? geminiError(429) : botReply('أهلاً بيك.')))
    const seeded = await seedClient()
    const visitorId = newVisitorId()

    const failed = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE, { visitorId })
    const conversationId = failed.body.conversationId as string
    const since = await needsHumanSince(seeded, conversationId)
    expect(since).not.toBeNull()

    // The assistant is back and answers the next message: the first is still unanswered
    down = false
    const next = await sendVisitorMessage(seeded.channelId, 'موجودين؟', { visitorId, conversationId })
    await flushAfter()
    expect(next.body.reply).toBe('أهلاً بيك.')
    expect(await needsHumanSince(seeded, conversationId)).toBe(since)

    const { error } = await seeded.supabase
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'agent', content: 'أهلاً يا أستاذ كريم، معاك الاستقبال.' })
    expect(error).toBeNull()
    expect(await needsHumanSince(seeded, conversationId)).toBeNull()
  })
})
