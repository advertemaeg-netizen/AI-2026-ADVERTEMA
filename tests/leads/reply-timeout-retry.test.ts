import { describe, expect, it } from 'vitest'
import { flushAfter, geminiCalls, geminiError, geminiText, mockGemini, seedClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply, INTRO_MESSAGE, sendVisitorMessage } from './webhook'

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

describe('a reply that times out is asked for once more', () => {
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

  it('gives up after the second timeout, with no reply stored', async () => {
    chatModel(() => {
      throw timeout()
    })
    const seeded = await seedClient()

    const { status, body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    await flushAfter()

    expect(status).toBe(502)
    expect(body.error).toBe('ai_unavailable')
    expect(replyCalls()).toBe(2)
    expect(await assistantMessages(seeded, body.conversationId as string)).toEqual([])
  })

  it('does not retry an error response', async () => {
    chatModel(() => geminiError(503))
    const seeded = await seedClient()

    const { status } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    await flushAfter()

    expect(status).toBe(502)
    expect(replyCalls()).toBe(1)
  })
})
