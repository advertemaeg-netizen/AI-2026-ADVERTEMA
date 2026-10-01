import { describe, expect, it } from 'vitest'
import { failRest, geminiCalls, mockGemini, seedClient } from '../harness/helpers'
import { geminiWorks, sendVisitorMessage, INTRO_MESSAGE } from './webhook'

type Seeded = Awaited<ReturnType<typeof seedClient>>

/** The client at its monthly message limit, with `captured(limit)` messages already analysed past it */
async function atMessageLimit({ supabase, clientId }: Seeded, captured: (limit: number) => number = () => 0, used = (l: number) => l) {
  const { data } = await supabase
    .from('client_subscriptions')
    .select('plan:plans(messages_limit)')
    .eq('client_id', clientId)
    .single<{ plan: { messages_limit: number } }>()
  const limit = data!.plan.messages_limit
  expect(limit).toBeGreaterThan(0)
  const { error } = await supabase
    .from('client_subscriptions')
    .update({ messages_used: used(limit), lead_capture_used: captured(limit) })
    .eq('client_id', clientId)
  expect(error).toBeNull()
  return limit
}

async function state({ supabase, clientId }: Seeded) {
  const { data: leads } = await supabase.from('leads').select('name, phone').eq('client_id', clientId)
  const { data: subscription } = await supabase
    .from('client_subscriptions')
    .select('messages_used, lead_capture_used')
    .eq('client_id', clientId)
    .single<{ messages_used: number; lead_capture_used: number }>()
  return { leads, messagesUsed: subscription!.messages_used, captured: subscription!.lead_capture_used }
}

const calls = (kind: 'reply' | 'analysis') => geminiCalls.filter((call) => call.kind === kind).length
const LEAD = [{ name: 'كريم مصطفى', phone: '01012345678' }]

describe('past the message limit', () => {
  it('stops replying but still captures the lead, counted apart from the plan\'s messages', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    const limit = await atMessageLimit(seeded)

    const { status, body } = await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)

    // The visitor gets the fallback message, not an AI reply
    expect(status).toBe(200)
    expect(body.ok).toBe(true)
    expect(calls('reply')).toBe(0)
    expect(calls('analysis')).toBe(1)
    // messages_used never passes the plan limit: alerts, admin tables and upgrades read it
    expect(await state(seeded)).toEqual({ leads: LEAD, messagesUsed: limit, captured: 1 })
    const { data: check } = await seeded.supabase.rpc('check_client_limit', { p_client_id: seeded.clientId, p_limit_type: 'messages' })
    expect(check).toMatchObject({ used: limit, limit, percentage: 100, reason: 'limit_reached' })
  })

  it('captures the last message of the allowance (twice the limit in total) and nothing after it', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    const limit = await atMessageLimit(seeded, (l) => l - 1)

    await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    expect(calls('analysis')).toBe(1)
    expect(await state(seeded)).toEqual({ leads: LEAD, messagesUsed: limit, captured: limit })

    // Allowance spent: no model call at all, and both counters stop
    await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)
    expect(calls('reply')).toBe(0)
    expect(calls('analysis')).toBe(1)
    expect(await state(seeded)).toEqual({ leads: LEAD, messagesUsed: limit, captured: limit })
  })

  it('takes nothing from the allowance for a message the bot answered', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    // The plan's last message: the reply uses it up, and its analysis is not counted again
    const limit = await atMessageLimit(seeded, () => 0, (l) => l - 1)

    await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)

    expect(calls('reply')).toBe(1)
    expect(calls('analysis')).toBe(1)
    expect(await state(seeded)).toEqual({ leads: LEAD, messagesUsed: limit, captured: 0 })
  })

  it('starts the allowance over with the new monthly window', async () => {
    mockGemini(geminiWorks)
    const seeded = await seedClient()
    const limit = await atMessageLimit(seeded, (l) => l)
    const lastMonth = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString()
    await seeded.supabase.from('client_subscriptions').update({ messages_period_start: lastMonth }).eq('client_id', seeded.clientId)

    await sendVisitorMessage(seeded.channelId, INTRO_MESSAGE)

    expect(limit).toBeGreaterThan(1)
    expect(calls('reply')).toBe(1)
    expect(await state(seeded)).toEqual({ leads: LEAD, messagesUsed: 1, captured: 0 })
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
