import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../app/api/webhook/meta/route'
import { connectWhatsApp, retryWhatsAppConnect } from '@/lib/actions/whatsapp-connect'
import { canManageClient } from '@/lib/auth/permissions'
import { createUser, flushAfter, graphCalls, interceptRest, mockGraph, seedClient, serviceClient, type GraphCall, type TestUser } from '../harness/helpers'

/**
 * A CLIENT CONNECTS A WHATSAPP NUMBER ITSELF (Embedded Signup; decided 2026-11-09).
 *
 * Meta's popup hands the browser a code and the WABA and number ids; the
 * server action trusts none of it until it has seen it. These hold:
 *   - the code exchanged WITHOUT a redirect_uri (the SDK's popup);
 *   - the token ours, a system user's, with both WhatsApp permissions;
 *   - a WABA the token was not granted, or a number not in the WABA, refused:
 *     the browser cannot name someone else's number;
 *   - a number another client holds refused; a full plan refused;
 *   - the channel created PAUSED, its token, WABA and PIN stored server-only;
 *   - the number registered with that PIN, then our app subscribed;
 *   - a connect that stopped at registering or subscribing resumed by "try
 *     again", never by signing up again;
 *   - a reconnect keeps the channel and its PIN;
 *   - PARTNER_REMOVED pauses the WABA's channels and says why;
 *   - the code, the token and the PIN never in the log.
 */

const APP_ID = '1764087628157038'
const APP_SECRET = 'app-secret-for-tests'
const CONFIG_ID = '1414870430631687'
const TOKEN = 'EAAG-system-user-token-never-logged'
const CODE = 'AQD-signup-code-never-logged'

const session = { user: null as TestUser | null }
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => {
    const { userClient, serviceClient: service } = await import('../harness/helpers')
    return { supabase: session.user ? userClient(session.user.id) : service(), profile: session.user, impersonation: null }
  },
  isImpersonating: async () => false,
  canManage: (profile: { role: string }) => canManageClient(profile.role),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

const service = serviceClient()
let output: () => string

beforeEach(() => {
  vi.stubEnv('META_APP_ID', APP_ID)
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
  vi.stubEnv('META_WHATSAPP_CONFIG_ID', CONFIG_ID)
  vi.stubEnv('META_VERIFY_TOKEN', 'verify-token-for-tests')
  const spies = (['info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  output = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
})
afterEach(() => {
  session.user = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const metaId = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`

type World = { wabaId: string; phoneNumberId: string; granted?: string[]; nameStatus?: string; register?: () => Response; subscribe?: () => Response; scopes?: string[] }

/** Graph as Meta answers the connect: the exchange, debug_token, the WABA's numbers, register, subscribed_apps */
function meta(world: World) {
  mockGraph((call: GraphCall) => {
    const path = new URL(call.url).pathname.replace(/^\/v\d+\.\d+\//, '')
    if (path === 'oauth/access_token') return Response.json({ access_token: TOKEN, token_type: 'bearer' })
    if (path === 'debug_token') {
      const granted = world.granted ?? [world.wabaId]
      return Response.json({
        data: {
          is_valid: true,
          app_id: APP_ID,
          type: 'SYSTEM_USER',
          scopes: world.scopes ?? ['whatsapp_business_management', 'whatsapp_business_messaging'],
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: granted },
            { scope: 'whatsapp_business_messaging', target_ids: granted },
          ],
        },
      })
    }
    if (path === `${world.wabaId}/phone_numbers`) {
      return Response.json({ data: [{ id: world.phoneNumberId, display_phone_number: '+20 100 000 0000', verified_name: 'Yasmine Clinic', name_status: world.nameStatus ?? 'PENDING_REVIEW' }] })
    }
    if (path.endsWith('/phone_numbers')) return Response.json({ error: { code: 100 } }, { status: 400 })
    if (path === `${world.phoneNumberId}/register`) return world.register?.() ?? Response.json({ success: true })
    if (path === `${world.wabaId}/subscribed_apps`) {
      if (call.method === 'POST') return world.subscribe?.() ?? Response.json({ success: true })
      return Response.json({ data: [{ whatsapp_business_api_data: { id: APP_ID } }] })
    }
    return Response.json({ error: { code: 100, message: `unexpected ${call.method} ${path}` } }, { status: 400 })
  })
}

async function signedIn() {
  const seeded = await seedClient()
  session.user = await createUser('org_admin', seeded.organizationId, 'مدير')
  return seeded
}

async function whatsappChannels(clientId: string) {
  const { data } = await service.from('channels').select('id, type, external_id, is_active, connection_notice').eq('client_id', clientId).eq('type', 'whatsapp')
  return (data ?? []) as { id: string; type: string; external_id: string; is_active: boolean; connection_notice: string | null }[]
}

async function secretOf(channelId: string) {
  const { data } = await service.from('channel_secrets').select('access_token, waba_id, registration_pin').eq('channel_id', channelId).maybeSingle()
  return data as { access_token: string; waba_id: string; registration_pin: string | null } | null
}

const call = (path: string) => graphCalls.filter((c) => new URL(c.url).pathname.endsWith(path))

describe('connecting a WhatsApp number', () => {
  it('exchanges the code without a redirect_uri, creates the channel paused, stores its secrets, registers the number with its PIN, subscribes our app', async () => {
    const { clientId } = await signedIn()
    const world = { wabaId: metaId(), phoneNumberId: metaId() }
    meta(world)

    const result = await connectWhatsApp(clientId, { code: CODE, ...world })

    expect(result).toMatchObject({ ok: true, status: 'connectedPaused' })
    const [exchange] = call('oauth/access_token')
    expect(exchange.body).toMatchObject({ client_id: APP_ID, client_secret: APP_SECRET, code: CODE })
    expect(exchange.body).not.toHaveProperty('redirect_uri')

    const [channel] = await whatsappChannels(clientId)
    expect(channel).toMatchObject({ id: result.channelId, external_id: world.phoneNumberId, is_active: false, connection_notice: 'name_pending' })
    const secret = await secretOf(channel.id)
    expect(secret).toMatchObject({ access_token: TOKEN, waba_id: world.wabaId })
    expect(secret!.registration_pin).toMatch(/^\d{6}$/)
    expect(call(`${world.phoneNumberId}/register`)[0].body).toMatchObject({ messaging_product: 'whatsapp', pin: secret!.registration_pin })
    expect(call(`${world.wabaId}/subscribed_apps`).some((c) => c.method === 'POST')).toBe(true)

    // Never the code, the token or the PIN in the log
    for (const secretText of [CODE, TOKEN, secret!.registration_pin!]) expect(output()).not.toContain(secretText)
  })

  it('an approved display name leaves the card nothing to say', async () => {
    const { clientId } = await signedIn()
    const world = { wabaId: metaId(), phoneNumberId: metaId(), nameStatus: 'APPROVED' }
    meta(world)
    await connectWhatsApp(clientId, { code: CODE, ...world })
    expect((await whatsappChannels(clientId))[0].connection_notice).toBeNull()
  })
})

describe('the browser is never trusted on the ids', () => {
  it('a WABA the token was not granted: refused, nothing created', async () => {
    const { clientId } = await signedIn()
    const world = { wabaId: metaId(), phoneNumberId: metaId(), granted: ['someone-elses-waba'] }
    meta(world)
    expect(await connectWhatsApp(clientId, { code: CODE, ...world })).toMatchObject({ ok: false, status: 'metaError' })
    expect(await whatsappChannels(clientId)).toEqual([])
  })

  it('a number not in the WABA: refused, nothing created, nothing registered', async () => {
    const { clientId } = await signedIn()
    const world = { wabaId: metaId(), phoneNumberId: metaId() }
    meta(world)
    expect(await connectWhatsApp(clientId, { code: CODE, wabaId: world.wabaId, phoneNumberId: metaId() })).toMatchObject({ ok: false, status: 'metaError' })
    expect(await whatsappChannels(clientId)).toEqual([])
    expect(graphCalls.some((c) => c.url.includes('/register'))).toBe(false)
  })

  it('malformed ids never reach Meta', async () => {
    const { clientId } = await signedIn()
    meta({ wabaId: metaId(), phoneNumberId: metaId() })
    expect(await connectWhatsApp(clientId, { code: CODE, wabaId: '../me', phoneNumberId: '1' })).toMatchObject({ ok: false, status: 'forbidden' })
    expect(graphCalls).toHaveLength(0)
  })

  it('a permission switched off in the popup: missingPermission', async () => {
    const { clientId } = await signedIn()
    const world = { wabaId: metaId(), phoneNumberId: metaId(), scopes: ['whatsapp_business_management'] }
    meta(world)
    expect(await connectWhatsApp(clientId, { code: CODE, ...world })).toMatchObject({ ok: false, status: 'missingPermission' })
    expect(await whatsappChannels(clientId)).toEqual([])
  })
})

describe('who holds the number, and the plan', () => {
  it('a number another client holds is refused', async () => {
    const world = { wabaId: metaId(), phoneNumberId: metaId() }
    const other = await seedClient()
    await service.from('channels').insert({ client_id: other.clientId, type: 'whatsapp', name: 'theirs', external_id: world.phoneNumberId, is_active: false })
    const { clientId } = await signedIn()
    meta(world)
    expect(await connectWhatsApp(clientId, { code: CODE, ...world })).toMatchObject({ ok: false, status: 'takenByOther' })
    expect(await whatsappChannels(clientId)).toEqual([])
  })

  it('a plan with no channel left: channelLimit, nothing created', async () => {
    const { clientId } = await signedIn()
    const world = { wabaId: metaId(), phoneNumberId: metaId() }
    meta(world)
    interceptRest({ path: '/rpc/check_client_limit' }, () => Response.json({ allowed: false, reason: 'limit_reached', limit: 1, used: 1 }))
    expect(await connectWhatsApp(clientId, { code: CODE, ...world })).toMatchObject({ ok: false, status: 'channelLimit' })
    expect(await whatsappChannels(clientId)).toEqual([])
  })
})

describe('a connect that stopped part-way resumes, never signs up again', () => {
  it('registering failed: the channel stays, paused, with its secrets; "try again" registers and subscribes', async () => {
    const { clientId } = await signedIn()
    let registerWorks = false
    const world = { wabaId: metaId(), phoneNumberId: metaId(), register: () => (registerWorks ? Response.json({ success: true }) : Response.json({ error: { code: 133005 } }, { status: 400 })) }
    meta(world)

    const first = await connectWhatsApp(clientId, { code: CODE, ...world })
    expect(first).toMatchObject({ ok: false, status: 'registerFailed' })
    const [channel] = await whatsappChannels(clientId)
    expect(channel).toMatchObject({ id: first.channelId, is_active: false })
    const pin = (await secretOf(channel.id))!.registration_pin

    registerWorks = true
    const exchanges = call('oauth/access_token').length
    const again = await retryWhatsAppConnect(clientId, channel.id)
    expect(again).toMatchObject({ ok: true, status: 'connectedPaused' })
    // No second signup: no code exchanged again, the same PIN registered
    expect(call('oauth/access_token')).toHaveLength(exchanges)
    expect(call(`${world.phoneNumberId}/register`).at(-1)!.body).toMatchObject({ pin })
  })

  it('subscribing failed: registered, and "try again" finishes it', async () => {
    const { clientId } = await signedIn()
    let subscribeWorks = false
    const world = { wabaId: metaId(), phoneNumberId: metaId(), subscribe: () => (subscribeWorks ? Response.json({ success: true }) : Response.json({ error: { code: 2 } }, { status: 500 })) }
    meta(world)

    const first = await connectWhatsApp(clientId, { code: CODE, ...world })
    expect(first).toMatchObject({ ok: false, status: 'subscribeFailed' })
    subscribeWorks = true
    expect(await retryWhatsAppConnect(clientId, first.channelId!)).toMatchObject({ ok: true, status: 'connectedPaused' })
  })

  it('"try again" on someone else’s channel is refused', async () => {
    const other = await seedClient()
    const { data: theirs } = await service.from('channels').insert({ client_id: other.clientId, type: 'whatsapp', name: 'theirs', external_id: metaId(), is_active: false }).select('id').single<{ id: string }>()
    const { clientId } = await signedIn()
    meta({ wabaId: metaId(), phoneNumberId: metaId() })
    expect(await retryWhatsAppConnect(clientId, theirs!.id)).toMatchObject({ ok: false, status: 'forbidden' })
    expect(graphCalls).toHaveLength(0)
  })
})

describe('a reconnect of the same number', () => {
  it('keeps the channel and its PIN, refreshes the token, and clears "removed by the business"', async () => {
    const { clientId } = await signedIn()
    const world = { wabaId: metaId(), phoneNumberId: metaId() }
    meta(world)
    const first = await connectWhatsApp(clientId, { code: CODE, ...world })
    const pin = (await secretOf(first.channelId!))!.registration_pin
    await service.from('channels').update({ connection_notice: 'removed_by_business' }).eq('id', first.channelId!)

    const again = await connectWhatsApp(clientId, { code: CODE, ...world })

    expect(again).toMatchObject({ ok: true, status: 'reconnected', channelId: first.channelId })
    expect(await whatsappChannels(clientId)).toHaveLength(1)
    expect((await secretOf(first.channelId!))!.registration_pin).toBe(pin)
    expect((await whatsappChannels(clientId))[0].connection_notice).toBe('name_pending')
  })
})

describe('the business removes our access in WhatsApp', () => {
  it('PARTNER_REMOVED pauses the WABA’s channels and the card says why', async () => {
    const { clientId } = await signedIn()
    const world = { wabaId: metaId(), phoneNumberId: metaId() }
    meta(world)
    const { channelId } = await connectWhatsApp(clientId, { code: CODE, ...world })
    await service.from('channels').update({ is_active: true }).eq('id', channelId!)

    const body = JSON.stringify({ object: 'whatsapp_business_account', entry: [{ id: world.wabaId, time: 1792569600, changes: [{ field: 'account_update', value: { event: 'PARTNER_REMOVED' } }] }] })
    await POST(
      new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
        body,
      })
    )
    await flushAfter()

    expect((await whatsappChannels(clientId))[0]).toMatchObject({ id: channelId, is_active: false, connection_notice: 'removed_by_business' })
  })
})
