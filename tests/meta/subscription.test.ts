import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { subscribeApp, subscribedApps } from '@/lib/meta/subscription'
import { graphCalls, mockGraph, seedClient, serviceClient } from '../harness/helpers'

/**
 * The subscribed_apps check and the subscribe call: the WABA's subscription
 * to our app read as a state, and taken as a step, with the token never in
 * the log.
 */

const TOKEN = 'EAAG-test-token-never-logged'
const OUR_APP = '1122334455667788'
const METAS_TEST_APP = '9988776655443322'
const WABA = '100200300400500'

beforeEach(() => {
  vi.stubEnv('META_APP_ID', OUR_APP)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function whatsappChannel(wabaId: string | null = WABA) {
  const seeded = await seedClient()
  const service = serviceClient()
  const { data: channel, error } = await service
    .from('channels')
    .insert({ client_id: seeded.clientId, type: 'whatsapp', name: 'WhatsApp', external_id: `PN-${crypto.randomUUID()}` })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: channel.id, access_token: TOKEN, waba_id: wabaId })
  if (secretError) throw secretError
  return { service, channelId: channel.id, seeded }
}

/** Meta's listing: each app under whatsapp_business_api_data, as the Cloud API answers */
const listing = (...appIds: string[]) =>
  Response.json({ data: appIds.map((id) => ({ whatsapp_business_api_data: { id, name: `App ${id}`, link: `https://www.facebook.com/games/?app_id=${id}` } })) })

function consoleOutput() {
  const spies = (['info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

describe('subscribedApps', () => {
  it('reads the WABA’s subscribed apps with the channel’s token and says our app is among them', async () => {
    const { service, channelId } = await whatsappChannel()
    const output = consoleOutput()
    mockGraph(() => listing(METAS_TEST_APP, OUR_APP))

    expect(await subscribedApps({ supabase: service, channelId })).toEqual({ kind: 'subscribed', appIds: [METAS_TEST_APP, OUR_APP] })
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].url).toBe(`https://graph.facebook.com/v25.0/${WABA}/subscribed_apps`)
    expect(graphCalls[0].method).toBe('GET')
    expect(graphCalls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(output()).not.toContain(TOKEN)
  })

  // 2026-10-26: subscribed to Meta's own "WA DevX Webhook Events 1P App", not ours; every screen read green
  it('says the WABA is not subscribed to our app when only another app is, and names that app', async () => {
    const { service, channelId } = await whatsappChannel()
    consoleOutput()
    mockGraph(() => listing(METAS_TEST_APP))
    expect(await subscribedApps({ supabase: service, channelId })).toEqual({ kind: 'not_subscribed', appIds: [METAS_TEST_APP] })
  })

  it('says the WABA is not subscribed when Meta lists nothing at all', async () => {
    const { service, channelId } = await whatsappChannel()
    consoleOutput()
    mockGraph(() => Response.json({ data: [] }))
    expect(await subscribedApps({ supabase: service, channelId })).toEqual({ kind: 'not_subscribed', appIds: [] })
  })

  it('asks nothing when the channel has no WABA id, no token, or our app id is unset', async () => {
    consoleOutput()
    mockGraph(() => listing(OUR_APP))
    const noWaba = await whatsappChannel(null)
    expect(await subscribedApps({ supabase: noWaba.service, channelId: noWaba.channelId })).toEqual({ kind: 'not_configured', missing: 'waba_id' })
    // The seeded website channel has no secret row
    expect(await subscribedApps({ supabase: noWaba.service, channelId: noWaba.seeded.channelId })).toEqual({ kind: 'not_configured', missing: 'token' })
    vi.stubEnv('META_APP_ID', '')
    const withWaba = await whatsappChannel()
    expect(await subscribedApps({ supabase: withWaba.service, channelId: withWaba.channelId })).toEqual({ kind: 'not_configured', missing: 'app_id' })
    expect(graphCalls).toHaveLength(0)
  })

  it('reports a refusal by status and code, without the token or the error text', async () => {
    const { service, channelId } = await whatsappChannel()
    const output = consoleOutput()
    mockGraph(() => Response.json({ error: { message: `Invalid OAuth access token ${TOKEN}`, code: 190 } }, { status: 401 }))
    expect(await subscribedApps({ supabase: service, channelId })).toEqual({ kind: 'failed', status: 401, code: 190 })
    expect(output()).not.toContain(TOKEN)
  })
})

describe('subscribeApp', () => {
  it('posts the subscription to the WABA, then reads the state back', async () => {
    const { service, channelId } = await whatsappChannel()
    consoleOutput()
    let subscribed = false
    mockGraph((call) => {
      if (call.method === 'POST') {
        subscribed = true
        return Response.json({ success: true })
      }
      return listing(...(subscribed ? [METAS_TEST_APP, OUR_APP] : [METAS_TEST_APP]))
    })

    expect(await subscribeApp({ supabase: service, channelId })).toEqual({ kind: 'subscribed', appIds: [METAS_TEST_APP, OUR_APP] })
    expect(graphCalls.map((call) => call.method)).toEqual(['POST', 'GET'])
    expect(graphCalls[0].url).toBe(`https://graph.facebook.com/v25.0/${WABA}/subscribed_apps`)
    expect(graphCalls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
  })

  it('reports a subscribe that Meta did not accept, and does not read the state', async () => {
    const { service, channelId } = await whatsappChannel()
    consoleOutput()
    mockGraph(() => Response.json({ error: { message: 'Unsupported post request', code: 100 } }, { status: 400 }))
    expect(await subscribeApp({ supabase: service, channelId })).toEqual({ kind: 'failed', status: 400, code: 100 })
    expect(graphCalls).toHaveLength(1)
  })
})
