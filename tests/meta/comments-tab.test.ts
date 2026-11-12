import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../app/api/webhook/meta/route'
import { getComments } from '@/lib/actions/comments'
import { getConversation, getConversations } from '@/lib/actions/conversations'
import { canManageClient } from '@/lib/auth/permissions'
import { createUser, flushAfter, graphCalls, mockGraph, seedClient, serviceClient, type GraphCall, type TestUser } from '../harness/helpers'

/**
 * THE COMMENTS TAB (.scratch/comments-tab-decisions.md, 1 to 3).
 *   - a comment thread leaves the conversations list; the private
 *     conversation stays in it;
 *   - each comment shows whether a public and a private reply went out, and
 *     "private sent" only for the comment whose own private reply was sent;
 *   - a comment links to its author's private conversation, found by the
 *     opener that names it: that conversation is keyed by the id Meta answered
 *     the send with, which here (as on Facebook) is NOT the commenter's id;
 *   - the private conversation knows the comment it began from;
 *   - the post is linked: Facebook's from its id, Instagram's read from the
 *     Graph API in one call, and left unlinked when that read fails;
 *   - another organization sees none of it.
 * Rows are found by content and id, never by created_at order.
 */

const APP_SECRET = 'app-secret-for-tests'
const TOKEN = 'EAAG-comments-tab-token'
const COMMENTER = '17900000000000077'
const RECIPIENT_IGSID = '526999888777000'
const PERMALINK = 'https://www.instagram.com/p/COMMENTS-TAB/'

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

beforeEach(() => {
  vi.stubEnv('META_VERIFY_TOKEN', 'verify-token-for-tests')
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => {
  session.user = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const isPrivate = (call: GraphCall) => call.url.endsWith('/messages')
const isPublic = (call: GraphCall) => call.url.endsWith('/replies')
const isPermalinks = (call: GraphCall) => call.url.includes('?ids=')

function meta({ permalinks = true }: { permalinks?: boolean } = {}) {
  mockGraph((call) => {
    if (isPrivate(call)) return Response.json({ recipient_id: RECIPIENT_IGSID, message_id: `m_${crypto.randomUUID()}` })
    if (isPublic(call)) return Response.json({ id: `REPLY-${crypto.randomUUID()}` })
    if (isPermalinks(call)) {
      return permalinks ? Response.json({ '17999000000000077': { permalink: PERMALINK, id: '17999000000000077' } }) : Response.json({ error: { code: 190 } }, { status: 400 })
    }
    throw new Error(`unexpected Graph call ${call.url}`)
  })
}

async function deliverComment(accountId: string, text: string) {
  const id = `C-${crypto.randomUUID()}`
  const value = { from: { id: COMMENTER, username: 'tab_patient' }, id, media: { id: '17999000000000077', media_product_type: 'FEED' }, text }
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: accountId, time: 1792569600, changes: [{ field: 'comments', value }] }] })
  const request = new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
    body,
  })
  expect((await POST(request)).status).toBe(200)
  await flushAfter()
  return id
}

/** An Instagram account with replies on, two comments from one person on one post, and the org's admin signed in */
async function twoComments() {
  const seeded = await seedClient()
  const service = serviceClient()
  const accountId = `1784${crypto.randomUUID().replace(/\D/g, '').slice(0, 12)}`
  const { data: channel, error } = await service
    .from('channels')
    .insert({ client_id: seeded.clientId, type: 'instagram', name: 'Instagram', external_id: accountId })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error
  await service.from('channel_secrets').insert({ channel_id: channel.id, access_token: TOKEN })
  await service.from('channels').update({ comment_replies_enabled: true }).eq('id', channel.id)
  meta()
  const first = await deliverComment(accountId, 'التقويم بكام؟')
  const second = await deliverComment(accountId, 'وفي تقسيط؟')
  session.user = await createUser('org_admin', seeded.organizationId, 'موظف')
  return { ...seeded, service, channelId: channel.id, first, second }
}

describe('the comments tab', () => {
  it('lists each comment with what went out, and links both to the private conversation the first one opened', async () => {
    const { clientId, first, second } = await twoComments()
    graphCalls.length = 0

    const comments = await getComments({ clientId })
    expect(comments).toHaveLength(2)
    const byId = new Map(comments.map((comment) => [comment.commentId, comment]))
    const one = byId.get(first)!
    const two = byId.get(second)!

    // The first: its own private reply, and the post's one public reply
    expect(one).toMatchObject({ text: 'التقويم بكام؟', publicReplySent: true, privateReplySent: true, contactName: 'tab_patient', postUrl: PERMALINK })
    // The second: its private reply was skipped (one was open), the post already had its public reply
    expect(two).toMatchObject({ text: 'وفي تقسيط؟', publicReplySent: false, privateReplySent: false, postUrl: PERMALINK })

    // The private conversation is keyed by the id Meta answered with, not the commenter's
    const service = serviceClient()
    const { data: dm } = await service.from('conversations').select('id, contact_identifier').eq('thread', 'dm').eq('id', one.dmConversationId!).single<{ id: string; contact_identifier: string }>()
    expect(dm!.contact_identifier).toBe(RECIPIENT_IGSID)
    expect(one.contactIdentifier).toBe(COMMENTER)
    expect(two.dmConversationId).toBe(one.dmConversationId)

    // One Graph read for the post links, with the channel's token
    expect(graphCalls.filter(isPermalinks)).toHaveLength(1)
    expect(graphCalls[0].url).toBe('https://graph.facebook.com/v26.0/?ids=17999000000000077&fields=permalink')
    expect(graphCalls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)

    // From the private conversation: where it began
    const loaded = await getConversation(one.dmConversationId!)
    expect(loaded?.origin).toEqual({ commentId: first })
  })

  it('a comment thread is not in the conversations list; the private conversation is', async () => {
    const { clientId, service, channelId } = await twoComments()
    const listed = await getConversations({ clientId })
    const { data: all } = await service.from('conversations').select('id, thread').eq('channel_id', channelId).returns<{ id: string; thread: string }[]>()
    const thread = all!.find((row) => row.thread === 'comments')!
    const dm = all!.find((row) => row.thread === 'dm')!
    expect(listed.map((row) => row.id)).toEqual([dm.id])
    expect(listed.map((row) => row.id)).not.toContain(thread.id)
    // A conversation that did not begin from a comment says nothing of one
    const { data: plain } = await service.from('conversations').insert({ client_id: clientId, channel_id: channelId, contact_identifier: `P-${crypto.randomUUID()}`, status: 'new' }).select('id').single<{ id: string }>()
    expect((await getConversation(plain!.id))?.origin).toBeNull()
  })

  it('a post link the Graph API will not give is left out, and the tab still loads', async () => {
    const { clientId } = await twoComments()
    meta({ permalinks: false })
    const comments = await getComments({ clientId })
    expect(comments).toHaveLength(2)
    expect(comments.every((comment) => comment.postUrl === null)).toBe(true)
  })

  it('a Facebook comment links its post from the post id; with no private reply, no conversation link', async () => {
    const seeded = await seedClient()
    const service = serviceClient()
    const { data: channel } = await service.from('channels').insert({ client_id: seeded.clientId, type: 'facebook', name: 'Page', external_id: `PAGE-${crypto.randomUUID()}` }).select('id').single<{ id: string }>()
    const { data: thread } = await service.from('conversations').insert({ client_id: seeded.clientId, channel_id: channel!.id, contact_identifier: 'FB-USER-1', contact_name: 'Facebook Person', thread: 'comments', status: 'new', auto_reply_enabled: false }).select('id').single<{ id: string }>()
    // The coordinator's shape for a comment it stored and did not answer (a hidden one)
    await service.from('messages').insert({ conversation_id: thread!.id, role: 'user', content: 'سؤال', metadata: { transport: 'facebook', comment: { commentId: '111_333', postId: '111_222', parentId: '111_222' } } })
    session.user = await createUser('org_admin', seeded.organizationId, 'موظف')

    const [comment] = await getComments({ clientId: seeded.clientId })
    expect(comment).toMatchObject({
      commentId: '111_333',
      postUrl: 'https://www.facebook.com/111/posts/222',
      publicReplySent: false,
      privateReplySent: false,
      dmConversationId: null,
      channel: { type: 'facebook' },
    })
  })

  it('another organization sees none of it', async () => {
    const { clientId } = await twoComments()
    const other = await seedClient()
    session.user = await createUser('org_admin', other.organizationId, 'غريب')
    expect(await getComments({ clientId })).toEqual([])
    expect(await getComments()).toEqual([])
  })
})
