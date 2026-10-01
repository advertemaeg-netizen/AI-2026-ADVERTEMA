import { describe, expect, it } from 'vitest'
import { failRest, geminiCalls, mockGemini, seedClient } from '../harness/helpers'
import { geminiWorks, sendVisitorMessage, INTRO_MESSAGE } from './webhook'

type Seeded = Awaited<ReturnType<typeof seedClient>>

/** The client's monthly message limit, with `used(limit)` messages already spent */
async function withMessagesUsed({ supabase, clientId }: Seeded, used: (limit: number) => number) {
  const { data } = await supabase
    .from('client_subscriptions')
    .select('plan:plans(messages_limit)')
    .eq('client_id', clientId)
    .single<{ plan: { messages_limit: number } }>()
  const limit = data!.plan.messages_limit
  expect(limit).toBeGreaterThan(0)
  const { error } = await supabase.from('client_subscriptions').update({ messages_used: used(limit) }).eq('client_id', clientId)
  expect(error).toBeNull()
  return limit
}

async function state({ supabase, clientId }: Seeded) {
  const { data: leads } = await supabase.from('leads').select('name, phone').eq('client_id', clientId)
  const { data: subscription } = await supabase
    .from('client_subscriptions')
    .select('messages_used')
    .eq('client_id', clientId)
    .single<{ messages_used: number }>()
  return { leads, messagesUsed: subscription!.messages_used }
}

const calls = (kind: 'reply' | 'analysis') => geminiCalls.filter((call) => call.kind === kind).length
const LEAD = [{ name: 'كريم مصطفى', phone: '01012345678' }]

describe('past the message limit', () => {
  it('stops replying but still captures the lead, counting the message toward the ceiling', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    const limit = await withMessagesUsed(seeded, (l) => l)

    const { status, body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)

    // The visitor gets the fallback message, not an AI reply
    expect(status).toBe(200)
    expect(calls('reply')).toBe(0)
    expect(calls('analysis')).toBe(1)
    expect(body.ok).toBe(true)
    expect(await state(seeded)).toEqual({ leads: LEAD, messagesUsed: limit + 1 })
  })

  it('captures the last message before the ceiling (twice the limit) and nothing after it', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    const limit = await withMessagesUsed(seeded, (l) => 2 * l - 1)

    await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    expect(calls('analysis')).toBe(1)
    expect(await state(seeded)).toEqual({ leads: LEAD, messagesUsed: 2 * limit })

    // At the ceiling: no model call at all, and the counter stops
    await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    expect(calls('reply')).toBe(0)
    expect(calls('analysis')).toBe(1)
    expect(await state(seeded)).toEqual({ leads: LEAD, messagesUsed: 2 * limit })
  })

  it('does not count messages the bot answered: under the limit only the reply is counted', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    const limit = await withMessagesUsed(seeded, (l) => l - 1)

    await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)

    expect(calls('reply')).toBe(1)
    expect(calls('analysis')).toBe(1)
    expect(await state(seeded)).toEqual({ leads: LEAD, messagesUsed: limit })
  })
})

describe('failures before the reply', () => {
  it('still analyses the message when bot_settings cannot be loaded', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    failRest('/rpc/get_bot_settings')

    const { status, body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)

    expect(status).toBe(502)
    expect(body).toMatchObject({ ok: false, error: 'ai_unavailable' })
    expect(calls('reply')).toBe(0)
    expect(calls('analysis')).toBe(1)
    expect((await state(seeded)).leads).toEqual(LEAD)
  })

  it('still analyses the message, without replying, when the limit check fails', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    // The route's check fails; the analysis runs its own a moment later
    failRest('/rpc/check_client_limit')

    const { status, body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)

    expect(status).toBe(502)
    expect(body).toMatchObject({ ok: false, error: 'ai_unavailable' })
    expect(calls('reply')).toBe(0)
    expect(calls('analysis')).toBe(1)
    expect((await state(seeded)).leads).toEqual(LEAD)
  })

  it('analyses nothing while the limit check keeps failing: no AI cost without a known subscription', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    failRest('/rpc/check_client_limit', 2)

    const { status } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)

    expect(status).toBe(502)
    expect(geminiCalls).toEqual([])
    expect((await state(seeded)).leads).toEqual([])
  })
})
