import { afterEach, describe, expect, it, vi } from 'vitest'
import { getChannels, setCommentRepliesAction } from '@/lib/actions/channels'
import { canManageClient } from '@/lib/auth/permissions'
import { createUser, seedClient, serviceClient, userClient, type TestUser } from '../harness/helpers'

/**
 * THE COMMENT-REPLIES SWITCH, ON THE CHANNEL (20261119100000).
 *   - a manager turns it on and off on a Facebook or Instagram channel;
 *   - who and when are stamped by the database, from the signed-in user,
 *     and cannot be set or forged through the API;
 *   - another update to the channel keeps the stamp;
 *   - a team member cannot change it; a website or WhatsApp channel cannot
 *     have it on at all;
 *   - the channels page shows who changed it, by name.
 */

const session = { user: null as TestUser | null, impersonating: false }
vi.mock('@/lib/auth/session', () => ({
  getSession: async () => {
    const { userClient: asUser, serviceClient: service } = await import('../harness/helpers')
    return { supabase: session.user ? asUser(session.user.id) : service(), profile: session.user, impersonation: null }
  },
  isImpersonating: async () => session.impersonating,
  canManage: (profile: { role: string }) => canManageClient(profile.role),
}))
vi.mock('next/cache', () => ({ revalidatePath: () => {} }))

afterEach(() => {
  session.user = null
  session.impersonating = false
  vi.restoreAllMocks()
})

async function clinic(type: 'instagram' | 'facebook' | 'whatsapp' = 'instagram') {
  const seeded = await seedClient()
  const service = serviceClient()
  const { data: channel, error } = await service
    .from('channels')
    .insert({ client_id: seeded.clientId, type, name: 'Account', external_id: `${Date.now()}${Math.floor(Math.random() * 1e6)}` })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error
  const admin = await createUser('org_admin', seeded.organizationId, 'منى المديرة')
  return { ...seeded, service, metaChannelId: channel.id, admin }
}

async function stamp(channelId: string) {
  const { data } = await serviceClient()
    .from('channels')
    .select('comment_replies_enabled, comment_replies_changed_by, comment_replies_changed_at')
    .eq('id', channelId)
    .single<{ comment_replies_enabled: boolean; comment_replies_changed_by: string | null; comment_replies_changed_at: string | null }>()
  return data!
}

describe('the comment-replies switch', () => {
  it('is off on a new channel, with no stamp', async () => {
    const { metaChannelId } = await clinic()
    expect(await stamp(metaChannelId)).toEqual({ comment_replies_enabled: false, comment_replies_changed_by: null, comment_replies_changed_at: null })
  })

  it('a manager turns it on and off; the database stamps who and when each time', async () => {
    const { metaChannelId, admin } = await clinic('facebook')
    session.user = admin

    expect(await setCommentRepliesAction(metaChannelId, true)).toEqual({ ok: true })
    const on = await stamp(metaChannelId)
    expect(on.comment_replies_enabled).toBe(true)
    expect(on.comment_replies_changed_by).toBe(admin.id)
    expect(on.comment_replies_changed_at).not.toBeNull()

    expect(await setCommentRepliesAction(metaChannelId, false)).toEqual({ ok: true })
    const off = await stamp(metaChannelId)
    expect(off.comment_replies_enabled).toBe(false)
    expect(off.comment_replies_changed_by).toBe(admin.id)
  })

  it('the channels page names who changed it', async () => {
    const { clientId, metaChannelId, admin } = await clinic()
    session.user = admin
    await setCommentRepliesAction(metaChannelId, true)
    const channel = (await getChannels(clientId)).find((c) => c.id === metaChannelId)!
    expect(channel.comment_replies_enabled).toBe(true)
    expect(channel.comment_replies_changed_by_name).toBe('منى المديرة')
    expect(channel.comment_replies_changed_at).not.toBeNull()
    expect(channel).not.toHaveProperty('comment_replies_changed_by')
  })

  it('cannot be forged through the API: the stamp is the signed-in user’s, whatever the request says', async () => {
    const { organizationId, metaChannelId, admin } = await clinic()
    const colleague = await createUser('org_admin', organizationId, 'زميل')
    const { error } = await userClient(admin.id)
      .from('channels')
      .update({ comment_replies_enabled: true, comment_replies_changed_by: colleague.id, comment_replies_changed_at: '2020-01-01T00:00:00Z' })
      .eq('id', metaChannelId)
    expect(error).toBeNull()
    const row = await stamp(metaChannelId)
    expect(row.comment_replies_changed_by).toBe(admin.id)
    expect(row.comment_replies_changed_at).not.toBe('2020-01-01T00:00:00+00:00')

    // Another column changed, with a forged stamp in the same request: the stamp stays as it was
    await userClient(colleague.id).from('channels').update({ name: 'Renamed', comment_replies_changed_by: colleague.id }).eq('id', metaChannelId)
    expect((await stamp(metaChannelId)).comment_replies_changed_by).toBe(admin.id)
  })

  it('a team member cannot change it, by the action or through the API', async () => {
    const { organizationId, metaChannelId } = await clinic()
    const member = await createUser('team_member', organizationId, 'عضو')
    session.user = member
    expect(await setCommentRepliesAction(metaChannelId, true)).toEqual({ ok: false, error: 'forbidden' })
    await userClient(member.id).from('channels').update({ comment_replies_enabled: true }).eq('id', metaChannelId)
    expect((await stamp(metaChannelId)).comment_replies_enabled).toBe(false)
  })

  it('cannot be on for a WhatsApp or website channel', async () => {
    const { metaChannelId: whatsappId, channelId: websiteId, admin, service } = await clinic('whatsapp')
    session.user = admin
    expect(await setCommentRepliesAction(whatsappId, true)).toEqual({ ok: false, error: 'notFound' })
    expect(await setCommentRepliesAction(websiteId, true)).toEqual({ ok: false, error: 'notFound' })
    // The check constraint, past every permission: refused even to the service role. Over this
    // harness's PostgREST a refused statement reads PGRST001, not 23514 (pglite#958), so the
    // refusal and the unchanged row are asserted, not the code
    const { error } = await service.from('channels').update({ comment_replies_enabled: true }).eq('id', websiteId)
    expect(error).not.toBeNull()
    expect((await stamp(websiteId)).comment_replies_enabled).toBe(false)
  })

  it('is refused while impersonating', async () => {
    const { metaChannelId, admin } = await clinic()
    session.user = admin
    session.impersonating = true
    expect(await setCommentRepliesAction(metaChannelId, true)).toEqual({ ok: false, error: 'impersonating' })
    expect((await stamp(metaChannelId)).comment_replies_enabled).toBe(false)
  })
})
