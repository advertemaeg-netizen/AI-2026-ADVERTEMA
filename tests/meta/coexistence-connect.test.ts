import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { connectWhatsApp, retryWhatsAppConnect } from '@/lib/actions/whatsapp-connect'
import { canManageClient } from '@/lib/auth/permissions'
import { createUser, graphCalls, mockGraph, seedClient, serviceClient, type GraphCall, type TestUser } from '../harness/helpers'

/**
 * CONNECTING A NUMBER KEPT ON THE WHATSAPP BUSINESS APP (2026-11-15; Meta's
 * "onboarding business app users"; behind META_WHATSAPP_COEXISTENCE). Unit
 * tests against a stand-in Graph: Meta's own answers are unverified until
 * the App Review is through and a spare number is connected.
 *   - the number is the WABA's one on both the app and the Cloud API
 *     (is_on_biz_app, platform_type CLOUD_API), whatever the popup said;
 *   - it is NOT registered and gets NO PIN;
 *   - our app is subscribed to the WABA as for any number;
 *   - contacts, then history, are requested once each (smb_app_data);
 *   - a request Meta refused is not asked again by itself; one that never
 *     reached Meta is, at most three times; past 24 hours, never.
 */

const APP_ID = '1764087628157038'
const TOKEN = 'EAAG-coexistence-system-user-token'

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

beforeEach(() => {
  vi.stubEnv('META_APP_ID', APP_ID)
  vi.stubEnv('META_APP_SECRET', 'app-secret-for-tests')
  vi.stubEnv('META_WHATSAPP_CONFIG_ID', '1414870430631687')
  vi.stubEnv('META_WHATSAPP_COEXISTENCE', 'on')
  for (const level of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => {
  session.user = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const metaId = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`
type World = { wabaId: string; numbers: { id: string; onBizApp: boolean }[]; sync?: (kind: string) => Response | 'unreachable' }

function meta(world: World) {
  mockGraph((call: GraphCall) => {
    const path = new URL(call.url).pathname.replace(/^\/v\d+\.\d+\//, '')
    if (path === 'oauth/access_token') return Response.json({ access_token: TOKEN, token_type: 'bearer' })
    if (path === 'debug_token') {
      return Response.json({
        data: {
          is_valid: true,
          app_id: APP_ID,
          type: 'SYSTEM_USER',
          scopes: ['whatsapp_business_management', 'whatsapp_business_messaging'],
          granular_scopes: [
            { scope: 'whatsapp_business_management', target_ids: [world.wabaId] },
            { scope: 'whatsapp_business_messaging', target_ids: [world.wabaId] },
          ],
        },
      })
    }
    if (path === `${world.wabaId}/phone_numbers`) {
      return Response.json({ data: world.numbers.map((n) => ({ id: n.id, display_phone_number: '+20 100 000 0000', verified_name: 'Yasmine Clinic', name_status: 'APPROVED' })) })
    }
    const number = world.numbers.find((n) => path === n.id)
    if (number) return Response.json({ id: number.id, is_on_biz_app: number.onBizApp, platform_type: 'CLOUD_API' })
    if (path.endsWith('/smb_app_data')) {
      const answer = world.sync?.(String(call.body.sync_type))
      if (answer === 'unreachable') throw new TypeError('fetch failed')
      return answer ?? Response.json({ messaging_product: 'whatsapp', request_id: `req-${call.body.sync_type}` })
    }
    if (path === `${world.wabaId}/subscribed_apps`) {
      if (call.method === 'POST') return Response.json({ success: true })
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

const syncCalls = () => graphCalls.filter((c) => new URL(c.url).pathname.endsWith('/smb_app_data'))
const registerCalls = () => graphCalls.filter((c) => new URL(c.url).pathname.endsWith('/register'))

async function channelOf(clientId: string) {
  const { data } = await service
    .from('channels')
    .select('id, external_id, is_active, whatsapp_mode, coexistence_onboarded_at, history_sync, contacts_sync')
    .eq('client_id', clientId)
    .eq('type', 'whatsapp')
    .single()
  return data as { id: string; external_id: string; is_active: boolean; whatsapp_mode: string; coexistence_onboarded_at: string | null; history_sync: string; contacts_sync: string }
}

describe('connecting a WhatsApp Business app number', () => {
  it('finds the number on the app, never registers it or sets a PIN, subscribes, then asks for contacts and history once each', async () => {
    const { clientId } = await signedIn()
    const app = metaId()
    const world = { wabaId: metaId(), numbers: [{ id: metaId(), onBizApp: false }, { id: app, onBizApp: true }] }
    meta(world)

    // Meta's coexistence finish carries the WABA alone
    const result = await connectWhatsApp(clientId, { code: 'AQD-code', wabaId: world.wabaId, phoneNumberId: null, coexistence: true })

    expect(result).toMatchObject({ ok: true, status: 'connectedPaused' })
    const channel = await channelOf(clientId)
    expect(channel).toMatchObject({ external_id: app, is_active: false, whatsapp_mode: 'coexistence', history_sync: 'requested', contacts_sync: 'requested' })
    expect(channel.coexistence_onboarded_at).not.toBeNull()
    expect(registerCalls()).toHaveLength(0)
    const { data: secret } = await service.from('channel_secrets').select('access_token, waba_id, registration_pin').eq('channel_id', channel.id).single()
    expect(secret).toEqual({ access_token: TOKEN, waba_id: world.wabaId, registration_pin: null })
    expect(graphCalls.some((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith(`${world.wabaId}/subscribed_apps`))).toBe(true)
    // Contacts first, then history (Meta's order), each once, on the number found
    expect(syncCalls().map((c) => [new URL(c.url).pathname.split('/').at(-2), c.body.sync_type])).toEqual([
      [app, 'smb_app_state_sync'],
      [app, 'history'],
    ])

    // "Try again" afterwards asks for nothing already accepted
    await retryWhatsAppConnect(clientId, channel.id)
    expect(syncCalls()).toHaveLength(2)
  })

  it('refuses a WABA with no number on the app, and one with two', async () => {
    const { clientId } = await signedIn()
    for (const numbers of [[{ id: metaId(), onBizApp: false }], [{ id: metaId(), onBizApp: true }, { id: metaId(), onBizApp: true }]]) {
      const world = { wabaId: metaId(), numbers }
      meta(world)
      expect(await connectWhatsApp(clientId, { code: 'AQD-code', wabaId: world.wabaId, phoneNumberId: null, coexistence: true })).toEqual({ ok: false, status: 'metaError' })
    }
    expect(syncCalls()).toHaveLength(0)
  })

  it('does not ask again by itself after Meta refused; asks again on "try again" within the 24 hours', async () => {
    const { clientId } = await signedIn()
    const app = metaId()
    let refuse = true
    const world: World = { wabaId: metaId(), numbers: [{ id: app, onBizApp: true }], sync: (kind) => (refuse && kind === 'history' ? Response.json({ error: { code: 131000 } }, { status: 500 }) : Response.json({ request_id: 'r' })) }
    meta(world)
    await connectWhatsApp(clientId, { code: 'AQD-code', wabaId: world.wabaId, phoneNumberId: app, coexistence: true })
    let channel = await channelOf(clientId)
    expect(channel).toMatchObject({ contacts_sync: 'requested', history_sync: 'request_failed' })
    expect(syncCalls().filter((c) => c.body.sync_type === 'history')).toHaveLength(1)

    refuse = false
    await retryWhatsAppConnect(clientId, channel.id)
    channel = await channelOf(clientId)
    expect(channel).toMatchObject({ contacts_sync: 'requested', history_sync: 'requested' })
    expect(syncCalls().filter((c) => c.body.sync_type === 'history')).toHaveLength(2)
    expect(syncCalls().filter((c) => c.body.sync_type === 'smb_app_state_sync')).toHaveLength(1)
  })

  it('asks again, three times at most, only when Meta never answered', async () => {
    const { clientId } = await signedIn()
    const app = metaId()
    const world: World = { wabaId: metaId(), numbers: [{ id: app, onBizApp: true }], sync: (kind) => (kind === 'history' ? 'unreachable' : Response.json({ request_id: 'r' })) }
    meta(world)
    await connectWhatsApp(clientId, { code: 'AQD-code', wabaId: world.wabaId, phoneNumberId: app, coexistence: true })
    expect(syncCalls().filter((c) => c.body.sync_type === 'history')).toHaveLength(3)
    expect(await channelOf(clientId)).toMatchObject({ history_sync: 'request_failed' })
  })

  it('past the 24 hours, asks for nothing and records the window as missed', async () => {
    const { clientId } = await signedIn()
    const app = metaId()
    const world: World = { wabaId: metaId(), numbers: [{ id: app, onBizApp: true }], sync: () => Response.json({ error: { code: 131000 } }, { status: 500 }) }
    meta(world)
    await connectWhatsApp(clientId, { code: 'AQD-code', wabaId: world.wabaId, phoneNumberId: app, coexistence: true })
    const channel = await channelOf(clientId)
    expect(channel).toMatchObject({ contacts_sync: 'request_failed', history_sync: 'request_failed' })
    await service.from('channels').update({ coexistence_onboarded_at: new Date(Date.now() - 25 * 3600_000).toISOString() }).eq('id', channel.id)
    const before = syncCalls().length

    await retryWhatsAppConnect(clientId, channel.id)
    expect(syncCalls()).toHaveLength(before)
    expect(await channelOf(clientId)).toMatchObject({ contacts_sync: 'window_missed', history_sync: 'window_missed' })
  })
})
