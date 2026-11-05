import { randomInt } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { GET as callback } from '../../app/api/oauth/meta/callback/route'
import { cancelMetaConnect, completeMetaConnect, getMetaConnectPicker, startMetaConnect } from '@/lib/actions/meta-connect'
import { canManageClient } from '@/lib/auth/permissions'
import { INSTAGRAM_FIELDS, PAGE_FIELDS, REQUIRED_SCOPES, connectOptions, pageOffered, type PageGrant } from '@/lib/meta/connect'
import { createUser, graphCalls, mockGraph, seedClient, serviceClient, userClient, type GraphCall, type TestUser } from '../harness/helpers'

/**
 * CONNECTING A PAGE AND AN INSTAGRAM ACCOUNT (.scratch/messenger-instagram-design.md §12).
 *
 * Meta's side is faked in the shapes the real logins of 2026-11-05 returned
 * (runs 1–4b): /me/accounts lists every Page ever granted, a Page the clinic
 * offered carries `tasks`, a Page carried in by its Instagram account has no
 * `tasks` field at all. What is under test is ours: the state binding, the
 * picker accepting only what it offered, the rule that we connect only what
 * the clinic offered, the refusals before the index, the seats, and the
 * reconnect that never changes a channel's account.
 */

const session = { user: null as TestUser | null, impersonating: false }
const signInAs = (user: TestUser | null, impersonating = false) => Object.assign(session, { user, impersonating })

vi.mock('@/lib/auth/session', () => ({
  getSession: async () => ({
    supabase: session.user ? userClient(session.user.id) : serviceClient(),
    profile: session.user,
    impersonation: session.impersonating ? { organizationId: session.user!.organization_id } : null,
  }),
  isImpersonating: async () => session.impersonating,
  canManage: (profile: { role: string }) => canManageClient(profile.role),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))
vi.mock('next/headers', () => ({ headers: async () => new Headers({ host: 'app.test' }) }))

const APP_ID = '1764087628157038'
const SYSTEM_TOKEN = 'SYS-not-a-real-token'
const PAGE_TOKEN = 'PAGE-not-a-real-token'
const ENV = {
  NEXT_PUBLIC_APP_URL: 'https://app.test',
  META_APP_ID: APP_ID,
  META_APP_SECRET: 'secret-not-real',
  META_LOGIN_CONFIG_ID: '1018979181243946',
} as const
const saved: Record<string, string | undefined> = {}

beforeAll(() => {
  for (const [key, value] of Object.entries(ENV)) {
    saved[key] = process.env[key]
    process.env[key] = value
  }
})
afterAll(() => {
  for (const key of Object.keys(ENV)) {
    if (saved[key] === undefined) delete process.env[key]
    else process.env[key] = saved[key]
  }
})

const admin = serviceClient()

// The clinic's assets, as /me/accounts lists them (ids are made up, shapes are the runs')
const OFFERED_TASKS = ['MANAGE_LEADS', 'MODERATE', 'MESSAGING', 'ANALYZE', 'ADVERTISE', 'CREATE_CONTENT', 'MANAGE']
let PAGE = ''
let IG = ''
type RawPage = { id: string; name: string; tasks?: string[]; access_token: string; instagram_business_account?: { id: string; username: string } }
/** Page offered by the clinic, with its Instagram account */
const offeredPage = (): RawPage => ({ id: PAGE, name: 'عيادة النور', tasks: OFFERED_TASKS, access_token: PAGE_TOKEN, instagram_business_account: { id: IG, username: 'alnoor' } })
/** The same Page, carried in by its Instagram account: no tasks field */
const carriedPage = (): RawPage => ({ id: PAGE, name: 'عيادة النور', access_token: PAGE_TOKEN, instagram_business_account: { id: IG, username: 'alnoor' } })

type Meta = { pages: RawPage[]; scopes: string[]; igBlocked: boolean }
let meta: Meta

function graph(call: GraphCall): Response {
  const path = new URL(call.url).pathname.replace(/^\/v\d+\.\d+\//, '')
  if (path === 'oauth/access_token') return Response.json({ access_token: SYSTEM_TOKEN, token_type: 'bearer' })
  if (path === 'debug_token') return Response.json({ data: { is_valid: true, app_id: APP_ID, type: 'SYSTEM_USER', expires_at: 0, scopes: meta.scopes } })
  if (path === 'me/accounts') return Response.json({ data: meta.pages, paging: { cursors: { before: 'b', after: 'a' } } })
  const [objectId, edge] = path.split('/')
  if (edge === 'subscribed_apps' && call.method === 'POST') return Response.json({ success: true })
  if (edge === 'subscribed_apps') {
    const fields = String(lastSubscribe(objectId)?.body.subscribed_fields ?? '').split(',').filter(Boolean)
    return objectId === IG ? Response.json({ data: [{ subscribed_fields: fields }] }) : Response.json({ data: [{ id: APP_ID, name: 'Mudrik', subscribed_fields: fields }] })
  }
  if (edge === 'conversations') {
    return meta.igBlocked
      ? Response.json({ error: { code: 200, message: 'The account owner has disabled access to Instagram Direct Messaging' } }, { status: 403 })
      : Response.json({ data: [] })
  }
  throw new Error(`unexpected Graph call ${call.method} ${path}`)
}
const lastSubscribe = (objectId: string) => graphCalls.filter((c) => c.method === 'POST' && c.url.includes(`/${objectId}/subscribed_apps`)).at(-1)

type World = { clientId: string; organizationId: string; websiteChannelId: string; orgAdmin: TestUser; colleague: TestUser; otherClientId: string }
let world: World

beforeEach(async () => {
  const seeded = await seedClient()
  const other = await seedClient()
  // Unique per test: the one-active-channel index spans every test's rows
  PAGE = `9${randomInt(1e9, 1e10)}015`
  IG = `178414${randomInt(1e9, 1e10)}41`
  world = {
    clientId: seeded.clientId,
    organizationId: seeded.organizationId,
    websiteChannelId: seeded.channelId,
    orgAdmin: await createUser('org_admin', seeded.organizationId, 'مدير'),
    colleague: await createUser('org_admin', seeded.organizationId, 'زميل'),
    otherClientId: other.clientId,
  }
  // The website channel, paused: its seat is free, so a pick of two fits the trial plan
  await admin.from('channels').update({ is_active: false }).eq('id', seeded.channelId)
  meta = { pages: [carriedPage()], scopes: [...REQUIRED_SCOPES, 'public_profile'], igBlocked: false }
  mockGraph(graph)
  signInAs(world.orgAdmin)
})

/** Starts a connect as the signed-in user and returns Meta's dialog URL */
async function start(channelId: string | null = null) {
  const result = await startMetaConnect(world.clientId, 'en', channelId)
  if (!result.ok) throw new Error(`start refused: ${result.status}`)
  return new URL(result.url)
}

/** Meta's return to the callback, followed: where it sent the browser */
async function returnFromMeta(query: Record<string, string>) {
  const response = await callback(new NextRequest(`https://app.test/api/oauth/meta/callback?${new URLSearchParams(query)}`))
  expect(response.status).toBe(303)
  return new URL(response.headers.get('location')!)
}

async function pendingRows() {
  const { data } = await admin.from('meta_connect_pending').select('id, state, access_token, options, channel_id').eq('client_id', world.clientId)
  return data!
}

async function metaChannels(clientId = world.clientId) {
  const { data } = await admin.from('channels').select('id, type, external_id, is_active, name').eq('client_id', clientId).in('type', ['facebook', 'instagram']).order('type')
  return data!
}

async function secretOf(channelId: string) {
  const { data } = await admin.from('channel_secrets').select('access_token').eq('channel_id', channelId).maybeSingle<{ access_token: string }>()
  return data?.access_token ?? null
}

/** A full login up to the picker; returns the pending row's id */
async function loginToPicker() {
  const dialog = await start()
  const landed = await returnFromMeta({ code: 'CODE', state: dialog.searchParams.get('state')! })
  const match = landed.pathname.match(/\/channels\/connect\/([0-9a-f-]{36})$/)
  if (!match) throw new Error(`expected the picker, landed on ${landed.href}`)
  return match[1]
}

describe('which Pages the clinic offered', () => {
  it('reads an offer only from tasks with MESSAGING; a missing field is absence, never unknown', () => {
    expect(pageOffered(OFFERED_TASKS)).toBe(true)
    expect(pageOffered(undefined)).toBe(false)
    expect(pageOffered(null)).toBe(false)
    expect(pageOffered([])).toBe(false)
    expect(pageOffered(['ANALYZE'])).toBe(false)
    expect(pageOffered('MESSAGING')).toBe(false)
  })

  it('makes a carried-in Page a choice for its Instagram account only, and drops a Page with neither', () => {
    const pages: PageGrant[] = [
      { id: 'P1', name: 'Offered', tasks: OFFERED_TASKS, pageToken: 't', instagram: null },
      { id: 'P2', name: 'Carried', tasks: null, pageToken: 't', instagram: { id: 'IG2', username: 'two' } },
      { id: 'P3', name: 'Neither', tasks: null, pageToken: 't', instagram: null },
    ]
    expect(connectOptions(pages)).toEqual([
      { pageId: 'P1', pageName: 'Offered', messenger: true, instagram: null },
      { pageId: 'P2', pageName: 'Carried', messenger: false, instagram: { id: 'IG2', username: 'two' } },
    ])
  })
})

describe('starting a connect', () => {
  it('sends the clinic to our configuration with a state, and binds it to this user and client', async () => {
    const dialog = await start()
    expect(dialog.origin + dialog.pathname).toBe('https://www.facebook.com/v26.0/dialog/oauth')
    expect(dialog.searchParams.get('config_id')).toBe('1018979181243946')
    expect(dialog.searchParams.get('redirect_uri')).toBe('https://app.test/api/oauth/meta/callback')
    expect(dialog.searchParams.get('client_id')).toBe(APP_ID)
    const rows = await pendingRows()
    expect(rows).toHaveLength(1)
    expect(rows[0].state).toBe(dialog.searchParams.get('state'))
    expect(rows[0].access_token).toBeNull()
  })

  it('drops the same user’s earlier connect for the client: a double click leaves one row', async () => {
    await start()
    const second = await start()
    const rows = await pendingRows()
    expect(rows.map((r) => r.state)).toEqual([second.searchParams.get('state')])
  })

  it('is refused while impersonating, and to someone who cannot see the client', async () => {
    signInAs(world.orgAdmin, true)
    expect(await startMetaConnect(world.clientId, 'en')).toEqual({ ok: false, status: 'impersonating' })
    signInAs(await createUser('org_admin', (await seedClient()).organizationId, 'غريب'))
    expect(await startMetaConnect(world.clientId, 'en')).toEqual({ ok: false, status: 'forbidden' })
    expect(await pendingRows()).toEqual([])
  })
})

describe('the return from Meta', () => {
  it('uses a state once: a replay lands on expired and stores nothing more', async () => {
    const state = (await start()).searchParams.get('state')!
    await returnFromMeta({ code: 'CODE', state })
    const replay = await returnFromMeta({ code: 'CODE', state })
    expect(replay.searchParams.get('connect')).toBe('expired')
    expect(await pendingRows()).toHaveLength(1)
  })

  it('refuses a session that is not the user who started the login, and keeps no token', async () => {
    const state = (await start()).searchParams.get('state')!
    signInAs(world.colleague)
    const landed = await returnFromMeta({ code: 'CODE', state })
    expect(landed.searchParams.get('connect')).toBe('forbidden')
    expect(await pendingRows()).toEqual([])
    expect(graphCalls).toEqual([])
  })

  it('takes a cancel in Meta’s dialog as cancelled, with nothing exchanged', async () => {
    const state = (await start()).searchParams.get('state')!
    const landed = await returnFromMeta({ error: 'access_denied', error_reason: 'user_denied', state })
    expect(landed.pathname).toBe(`/en/dashboard/clients/${world.clientId}/channels`)
    expect(landed.searchParams.get('connect')).toBe('cancelled')
    expect(await pendingRows()).toEqual([])
    expect(graphCalls).toEqual([])
  })

  it('refuses a token with a permission switched off', async () => {
    meta.scopes = REQUIRED_SCOPES.filter((s) => s !== 'instagram_manage_messages')
    const landed = await returnFromMeta({ code: 'CODE', state: (await start()).searchParams.get('state')! })
    expect(landed.searchParams.get('connect')).toBe('missingPermission')
    expect(await pendingRows()).toEqual([])
  })

  it('lands on empty when the token sees nothing to connect', async () => {
    meta.pages = [{ id: PAGE, name: 'No offer, no Instagram', access_token: PAGE_TOKEN }]
    const landed = await returnFromMeta({ code: 'CODE', state: (await start()).searchParams.get('state')! })
    expect(landed.searchParams.get('connect')).toBe('empty')
    expect(await pendingRows()).toEqual([])
  })

  it('keeps the token on the server for the picker: the browser gets the row id, the row no token in its options', async () => {
    const pendingId = await loginToPicker()
    const [row] = await pendingRows()
    expect(row.id).toBe(pendingId)
    expect(row.access_token).toBe(SYSTEM_TOKEN)
    expect(row.state).toBeNull()
    expect(JSON.stringify(row.options)).not.toContain('not-a-real-token')
    // Every token went in a header or a body, never a URL
    for (const call of graphCalls) expect(call.url).not.toMatch(/not-a-real-token|secret-not-real|CODE/)
    expect(graphCalls.find((c) => c.url.endsWith('/oauth/access_token'))?.body).toMatchObject({ code: 'CODE', redirect_uri: 'https://app.test/api/oauth/meta/callback' })
  })
})

describe('the picker', () => {
  it('offers a carried-in Page’s Instagram account and never its Messenger', async () => {
    const pendingId = await loginToPicker()
    const view = await getMetaConnectPicker(pendingId, world.clientId)
    expect(view?.options).toEqual([{ pageId: PAGE, pageName: 'عيادة النور', messenger: null, instagram: { username: 'alnoor', availability: 'available' } }])
  })

  it('is nobody else’s to see or complete', async () => {
    const pendingId = await loginToPicker()
    signInAs(world.colleague)
    expect(await getMetaConnectPicker(pendingId, world.clientId)).toBeNull()
    expect(await completeMetaConnect(pendingId, world.clientId, { pageId: PAGE, messenger: false, instagram: true })).toEqual({ ok: false, status: 'expired' })
    expect(await metaChannels()).toEqual([])
  })

  it('connects only what was ticked: Instagram only is an Instagram channel only, with the system-user token', async () => {
    meta.pages = [offeredPage()]
    const pendingId = await loginToPicker()
    const result = await completeMetaConnect(pendingId, world.clientId, { pageId: PAGE, messenger: false, instagram: true })
    expect(result).toEqual({ ok: true, status: 'connected' })
    const channels = await metaChannels()
    expect(channels).toEqual([{ id: expect.any(String), type: 'instagram', external_id: IG, is_active: true, name: '@alnoor' }])
    expect(await secretOf(channels[0].id)).toBe(SYSTEM_TOKEN)
    expect(lastSubscribe(IG)?.body.subscribed_fields).toBe(INSTAGRAM_FIELDS.join(','))
    expect(lastSubscribe(PAGE)).toBeUndefined()
    expect(await pendingRows()).toEqual([])
  })

  it('refuses Messenger for a Page the clinic did not offer, whatever the request says', async () => {
    const pendingId = await loginToPicker()
    const result = await completeMetaConnect(pendingId, world.clientId, { pageId: PAGE, messenger: true, instagram: true })
    expect(result).toEqual({ ok: false, status: 'forbidden' })
    expect(await metaChannels()).toEqual([])
  })

  it('connects Messenger for an offered Page with its Page token, subscribed to the four Page fields', async () => {
    meta.pages = [offeredPage()]
    const pendingId = await loginToPicker()
    const result = await completeMetaConnect(pendingId, world.clientId, { pageId: PAGE, messenger: true, instagram: true })
    expect(result).toEqual({ ok: true, status: 'connected' })
    const channels = await metaChannels()
    expect(channels.map((c) => [c.type, c.external_id])).toEqual([
      ['facebook', PAGE],
      ['instagram', IG],
    ])
    expect(await secretOf(channels[0].id)).toBe(PAGE_TOKEN)
    expect(lastSubscribe(PAGE)?.body.subscribed_fields).toBe(PAGE_FIELDS.join(','))
    expect(lastSubscribe(PAGE)?.headers.authorization).toBe(`Bearer ${PAGE_TOKEN}`)
  })

  it('refuses an account another client holds, even paused, before the database sees it', async () => {
    await admin.from('channels').insert({ client_id: world.otherClientId, type: 'instagram', name: 'paused elsewhere', external_id: IG, is_active: false })
    const pendingId = await loginToPicker()
    const view = await getMetaConnectPicker(pendingId, world.clientId)
    expect(view?.options[0].instagram?.availability).toBe('otherClient')
    const result = await completeMetaConnect(pendingId, world.clientId, { pageId: PAGE, messenger: false, instagram: true })
    expect(result).toEqual({ ok: false, status: 'accountOnOtherClient' })
    expect(await metaChannels()).toEqual([])
  })

  it('refreshes this client’s own channel rather than adding a second', async () => {
    const { data: existing } = await admin.from('channels').insert({ client_id: world.clientId, type: 'instagram', name: '@alnoor', external_id: IG }).select('id').single<{ id: string }>()
    const pendingId = await loginToPicker()
    expect((await getMetaConnectPicker(pendingId, world.clientId))?.options[0].instagram?.availability).toBe('connected')
    expect(await completeMetaConnect(pendingId, world.clientId, { pageId: PAGE, messenger: false, instagram: true })).toEqual({ ok: true, status: 'reconnected' })
    expect((await metaChannels()).map((c) => c.id)).toEqual([existing!.id])
    expect(await secretOf(existing!.id)).toBe(SYSTEM_TOKEN)
  })

  it('checks both seats before creating either: one free seat for two channels is limitReachedTwo', async () => {
    meta.pages = [offeredPage()]
    await admin.from('channels').update({ is_active: true }).eq('id', world.websiteChannelId)
    const { data } = await admin.rpc('client_usage', { p_client_id: world.clientId })
    const seats = (data as { limit_type: string; used: number; limit_value: number | null }[]).find((u) => u.limit_type === 'channels')!
    expect(seats.limit_value).not.toBeNull()
    for (let i = seats.used; i < seats.limit_value! - 1; i += 1) {
      await admin.from('channels').insert({ client_id: world.clientId, type: 'website', name: `filler ${i}` })
    }
    const pendingId = await loginToPicker()
    const result = await completeMetaConnect(pendingId, world.clientId, { pageId: PAGE, messenger: true, instagram: true })
    expect(result).toEqual({ ok: false, status: 'limitReachedTwo' })
    expect(await metaChannels()).toEqual([])
  })

  it('says when messages are blocked by the Instagram account (#200)', async () => {
    meta.igBlocked = true
    const pendingId = await loginToPicker()
    expect(await completeMetaConnect(pendingId, world.clientId, { pageId: PAGE, messenger: false, instagram: true })).toEqual({ ok: true, status: 'connectedMessagesBlocked' })
  })

  it('drops the token on cancel', async () => {
    const pendingId = await loginToPicker()
    await cancelMetaConnect(pendingId, world.clientId)
    expect(await pendingRows()).toEqual([])
  })
})

describe('a reconnect', () => {
  it('keeps the channel’s account and refreshes its token, with no picker', async () => {
    const { data: channel } = await admin.from('channels').insert({ client_id: world.clientId, type: 'instagram', name: '@alnoor', external_id: IG }).select('id').single<{ id: string }>()
    await admin.from('channel_secrets').insert({ channel_id: channel!.id, access_token: 'OLD-token' })
    const landed = await returnFromMeta({ code: 'CODE', state: (await start(channel!.id)).searchParams.get('state')! })
    expect(landed.searchParams.get('connect')).toBe('reconnected')
    expect(await secretOf(channel!.id)).toBe(SYSTEM_TOKEN)
    expect(await pendingRows()).toEqual([])
  })

  it('changes nothing when the channel’s account was not shared this time', async () => {
    const { data: channel } = await admin.from('channels').insert({ client_id: world.clientId, type: 'instagram', name: '@old', external_id: '17841400000000999' }).select('id').single<{ id: string }>()
    await admin.from('channel_secrets').insert({ channel_id: channel!.id, access_token: 'OLD-token' })
    const landed = await returnFromMeta({ code: 'CODE', state: (await start(channel!.id)).searchParams.get('state')! })
    expect(landed.searchParams.get('connect')).toBe('notShared')
    expect(await secretOf(channel!.id)).toBe('OLD-token')
    expect((await metaChannels()).map((c) => c.external_id)).toEqual(['17841400000000999'])
  })

  it('does not keep Messenger on a Page that is now only carried in by its Instagram account', async () => {
    const { data: channel } = await admin.from('channels').insert({ client_id: world.clientId, type: 'facebook', name: 'عيادة النور', external_id: PAGE }).select('id').single<{ id: string }>()
    await admin.from('channel_secrets').insert({ channel_id: channel!.id, access_token: 'OLD-token' })
    const landed = await returnFromMeta({ code: 'CODE', state: (await start(channel!.id)).searchParams.get('state')! })
    expect(landed.searchParams.get('connect')).toBe('notShared')
    expect(await secretOf(channel!.id)).toBe('OLD-token')
  })
})
