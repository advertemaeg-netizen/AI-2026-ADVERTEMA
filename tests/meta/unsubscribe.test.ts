import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteChannelAction } from '@/lib/actions/channels'
import { canManageClient } from '@/lib/auth/permissions'
import { createUser, graphCalls, mockGraph, seedClient, serviceClient, type GraphCall, type TestUser } from '../harness/helpers'

/**
 * DISCONNECTING TAKES OUR APP OFF THE ACCOUNT (src/lib/meta/unsubscribe.ts).
 *   - deleting a Facebook, Instagram or WhatsApp channel asks Meta to
 *     unsubscribe our app from its Page, Instagram account or WABA, with the
 *     channel's own token, before the token is deleted with the row;
 *   - not when another channel row of ours uses the same object;
 *   - a refusal or an unreachable Meta never stops the delete, and is
 *     logged with the object id and Meta's code, never the token;
 *   - a website channel asks Meta nothing; a team member deletes nothing.
 */

const TOKEN = 'EAAG-unsubscribe-token-never-logged'

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

let output: () => string
beforeEach(() => {
  const spies = (['info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  output = () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
})
afterEach(() => {
  session.user = null
  vi.restoreAllMocks()
})

const service = serviceClient()
const metaId = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`

async function channel(clientId: string, type: 'facebook' | 'instagram' | 'whatsapp', externalId: string, opts: { active?: boolean; wabaId?: string } = {}) {
  const { data, error } = await service
    .from('channels')
    .insert({ client_id: clientId, type, name: type, external_id: externalId, is_active: opts.active ?? true })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: data.id, access_token: TOKEN, ...(opts.wabaId ? { waba_id: opts.wabaId } : {}) })
  if (secretError) throw secretError
  return data.id
}

async function clinic() {
  const seeded = await seedClient()
  session.user = await createUser('org_admin', seeded.organizationId, 'مدير')
  return seeded
}

const exists = async (id: string) => ((await service.from('channels').select('id').eq('id', id)).data ?? []).length > 0
const deletes = () => graphCalls.filter((call: GraphCall) => call.method === 'DELETE')

describe('deleting a Meta channel', () => {
  it('unsubscribes our app from the Page with the channel’s token, then deletes the channel', async () => {
    const { clientId } = await clinic()
    const pageId = metaId()
    const id = await channel(clientId, 'facebook', pageId)
    mockGraph(() => Response.json({ success: true }))

    expect(await deleteChannelAction(id)).toEqual({ ok: true })
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0].url).toBe(`https://graph.facebook.com/v26.0/${pageId}/subscribed_apps`)
    expect(deletes()[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(await exists(id)).toBe(false)
    expect(output()).toContain('[meta/unsubscribe] unsubscribed')
    expect(output()).toContain(pageId)
    expect(output()).not.toContain(TOKEN)
  })

  it('unsubscribes an Instagram account by its own id', async () => {
    const { clientId } = await clinic()
    const igId = `1784${metaId()}`
    const id = await channel(clientId, 'instagram', igId)
    mockGraph(() => Response.json({ success: true }))
    expect(await deleteChannelAction(id)).toEqual({ ok: true })
    expect(deletes()[0].url).toBe(`https://graph.facebook.com/v26.0/${igId}/subscribed_apps`)
  })

  it('a refusal never stops the delete, and is logged with the Page id and Meta’s code', async () => {
    const { clientId } = await clinic()
    const pageId = metaId()
    const id = await channel(clientId, 'facebook', pageId)
    mockGraph(() => Response.json({ error: { code: 190, error_subcode: 463, message: 'expired' } }, { status: 400 }))

    expect(await deleteChannelAction(id)).toEqual({ ok: true })
    expect(await exists(id)).toBe(false)
    const logged = output()
    expect(logged).toContain('[meta/unsubscribe] refused')
    expect(logged).toContain(pageId)
    expect(logged).toContain('190')
    expect(logged).toContain('463')
    expect(logged).not.toContain(TOKEN)
  })

  it('Meta unreachable never stops the delete either', async () => {
    const { clientId } = await clinic()
    const id = await channel(clientId, 'instagram', `1784${metaId()}`)
    mockGraph(() => {
      throw new TypeError('fetch failed')
    })
    expect(await deleteChannelAction(id)).toEqual({ ok: true })
    expect(await exists(id)).toBe(false)
    expect(output()).toContain('[meta/unsubscribe] request_failed')
  })

  it('keeps the Page subscribed while another channel of ours uses it', async () => {
    const { clientId } = await clinic()
    const other = await seedClient()
    const pageId = metaId()
    const id = await channel(clientId, 'facebook', pageId)
    // The same Page held by another client, paused (only one may be active)
    await channel(other.clientId, 'facebook', pageId, { active: false })
    mockGraph(() => Response.json({ success: true }))

    expect(await deleteChannelAction(id)).toEqual({ ok: true })
    expect(deletes()).toHaveLength(0)
    expect(await exists(id)).toBe(false)
    expect(output()).toContain('[meta/unsubscribe] kept')
  })

  it('unsubscribes a WhatsApp Business Account only when no other number of ours is on it', async () => {
    const { clientId } = await clinic()
    const waba = metaId()
    // Both paused: the trial plan's two seats would refuse the second insert (channels_enforce_limit
    // counts active channels on any insert); a delete does not care whether a channel is on
    const first = await channel(clientId, 'whatsapp', `PN-${metaId()}`, { wabaId: waba, active: false })
    const second = await channel(clientId, 'whatsapp', `PN-${metaId()}`, { wabaId: waba, active: false })
    mockGraph(() => Response.json({ success: true }))

    expect(await deleteChannelAction(first)).toEqual({ ok: true })
    expect(deletes()).toHaveLength(0)

    expect(await deleteChannelAction(second)).toEqual({ ok: true })
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0].url).toBe(`https://graph.facebook.com/v25.0/${waba}/subscribed_apps`)
  })

  it('a website channel asks Meta nothing', async () => {
    const { channelId } = await clinic()
    mockGraph(() => Response.json({ success: true }))
    expect(await deleteChannelAction(channelId)).toEqual({ ok: true })
    expect(graphCalls).toHaveLength(0)
  })

  it('a team member deletes nothing and asks Meta nothing', async () => {
    const { clientId, organizationId } = await clinic()
    const id = await channel(clientId, 'facebook', metaId())
    session.user = await createUser('team_member', organizationId, 'عضو')
    mockGraph(() => Response.json({ success: true }))
    expect(await deleteChannelAction(id)).toEqual({ ok: false, error: 'forbidden' })
    expect(graphCalls).toHaveLength(0)
    expect(await exists(id)).toBe(true)
  })
})
