import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../app/api/webhook/meta/route'
import { openerFor } from '@/lib/meta/comments'
import { COMMENT_PRIVATE_OPENER_AR, COMMENT_PUBLIC_INVITE_AR, COMMENT_PUBLIC_SENT_AR } from '@/lib/meta/comment-strings-ar'
import { flushAfter, geminiCalls, graphCalls, mockGraph, seedClient, serviceClient, type GraphCall } from '../harness/helpers'

/**
 * INSTAGRAM COMMENTS, IN THE OWNER'S ORDER (.scratch/comments-decisions-and-arabic.md).
 * Claim first; the private reply; then the public reply, from set A only if
 * the private reply went, the invite if not. The model is never called. The
 * same comment twice is one reply of each. Our own replies, the account's
 * comments, replies inside a thread, mentions: never answered. And while the
 * client's switch is off, nothing at all.
 *
 * Nothing here reads order from created_at (the harness's clock is
 * unreliable for that): the order of the two sends is the order of the
 * Graph calls, which is the order the code made them.
 */

const APP_SECRET = 'app-secret-for-tests'
const TOKEN = 'EAAG-system-user-token-never-logged'
const COMMENTER = '17900000000000001'
const USERNAME = 'patient_username'
const RECIPIENT_IGSID = '526999888777666'
const COMMENT_TEXT = 'عندي ألم في ضرس العقل، الخلع بكام؟'

beforeEach(() => {
  vi.stubEnv('META_VERIFY_TOKEN', 'verify-token-for-tests')
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

async function liveAccount({ switchedOn = true }: { switchedOn?: boolean } = {}) {
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
  if (switchedOn) await service.from('channels').update({ comment_replies_enabled: true }).eq('id', channel.id)
  const { data: client } = await service.from('clients').select('name').eq('id', seeded.clientId).single<{ name: string }>()
  return { ...seeded, service, accountId, channelId: channel.id, clinicName: client!.name }
}

type Comment = { id?: string; text?: string; fromId?: string; parentId?: string; field?: string; mediaId?: string }

async function deliverComment(accountId: string, { id = `C-${crypto.randomUUID()}`, text = COMMENT_TEXT, fromId = COMMENTER, parentId, field = 'comments', mediaId = 'MEDIA-1' }: Comment = {}) {
  // The shape Instagram actually delivered to us: the comment's id as `id`
  const value: Record<string, unknown> = { from: { id: fromId, username: USERNAME }, id, media: { id: mediaId, media_product_type: 'FEED' }, text, ...(parentId ? { parent_id: parentId } : {}) }
  const body = JSON.stringify({ object: 'instagram', entry: [{ id: accountId, time: 1792569600, changes: [{ field, value: field === 'mentions' ? { comment_id: id, media_id: 'OTHER-MEDIA' } : value }] }] })
  const request = new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
    body,
  })
  const response = await POST(request)
  await flushAfter()
  return { response, id }
}

const isPrivate = (call: GraphCall) => call.url.endsWith('/messages')
const isPublic = (call: GraphCall) => call.url.endsWith('/replies')

/** Meta's answers: the private reply's recipient and mid, the public reply's new comment id */
function meta({ privateFails = false, publicFails = false }: { privateFails?: boolean; publicFails?: boolean } = {}) {
  let replies = 0
  mockGraph((call) => {
    if (isPrivate(call)) {
      return privateFails
        ? Response.json({ error: { code: 100, error_subcode: 2534025, message: 'The comment is invalid for a private reply' } }, { status: 400 })
        : Response.json({ recipient_id: RECIPIENT_IGSID, message_id: `m_PRIVATE_${crypto.randomUUID()}` })
    }
    if (isPublic(call)) {
      replies += 1
      return publicFails ? Response.json({ error: { code: 1, message: 'An unknown error occurred' } }, { status: 500 }) : Response.json({ id: `REPLY-${replies}-${crypto.randomUUID()}` })
    }
    throw new Error(`unexpected Graph call ${call.url}`)
  })
}

function consoleOutput() {
  const spies = (['info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

async function conversationsOf(service: ReturnType<typeof serviceClient>, channelId: string) {
  const { data } = await service
    .from('conversations')
    .select('id, contact_identifier, contact_name, thread, auto_reply_enabled')
    .eq('channel_id', channelId)
    .returns<{ id: string; contact_identifier: string; contact_name: string | null; thread: string; auto_reply_enabled: boolean }[]>()
  return data ?? []
}

async function rowsOf(service: ReturnType<typeof serviceClient>, conversationId: string) {
  const { data } = await service.from('messages').select('role, content, metadata').eq('conversation_id', conversationId).returns<{ role: string; content: string; metadata: Record<string, unknown> | null }[]>()
  return data ?? []
}

async function claimOf(service: ReturnType<typeof serviceClient>, commentId: string) {
  const { data } = await service.from('meta_comment_replies').select('*').eq('comment_id', commentId).maybeSingle<Record<string, unknown>>()
  return data
}

describe('a comment on the client’s media, switch on', () => {
  it('the private reply first, then a public reply from set A; the comment thread holds the public side, the DM the opener', async () => {
    const { service, channelId, accountId, clinicName } = await liveAccount()
    const output = consoleOutput()
    meta()

    const { response, id } = await deliverComment(accountId)
    expect(response.status).toBe(200)

    // Two calls, the private one first
    expect(graphCalls.map((c) => (isPrivate(c) ? 'private' : isPublic(c) ? 'public' : c.url))).toEqual(['private', 'public'])
    const [privateCall, publicCall] = graphCalls
    expect(privateCall.url).toBe(`https://graph.facebook.com/v26.0/${accountId}/messages`)
    expect(privateCall.headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(privateCall.body).toEqual({ recipient: { comment_id: id }, message: { text: COMMENT_PRIVATE_OPENER_AR.replace('{{clinic}}', clinicName) } })
    expect(publicCall.url).toBe(`https://graph.facebook.com/v26.0/${id}/replies`)
    expect(COMMENT_PUBLIC_SENT_AR).toContain(publicCall.body.message)

    // Nothing the comment said reached anything we sent, and the model was never asked
    for (const call of graphCalls) expect(JSON.stringify(call.body)).not.toContain('ضرس')
    expect(geminiCalls).toHaveLength(0)

    const conversations = await conversationsOf(service, channelId)
    const thread = conversations.find((c) => c.thread === 'comments')!
    const dm = conversations.find((c) => c.thread === 'dm')!
    expect(conversations).toHaveLength(2)
    expect(thread).toMatchObject({ contact_identifier: COMMENTER, contact_name: USERNAME, auto_reply_enabled: false })
    // The DM is keyed by the id Meta answered with, never the comment author's id assumed
    expect(dm).toMatchObject({ contact_identifier: RECIPIENT_IGSID })

    const threadRows = await rowsOf(service, thread.id)
    expect(threadRows.map((m) => m.role).sort()).toEqual(['assistant', 'user'])
    expect(threadRows.find((m) => m.role === 'user')!.content).toBe(COMMENT_TEXT)
    expect(COMMENT_PUBLIC_SENT_AR).toContain(threadRows.find((m) => m.role === 'assistant')!.content)
    // The private side never appears on the public one
    expect(threadRows.some((m) => m.content.includes('شفنا تعليقك'))).toBe(false)

    const dmRows = await rowsOf(service, dm.id)
    expect(dmRows).toHaveLength(1)
    expect(dmRows[0]).toMatchObject({ role: 'assistant', metadata: { origin: { commentId: id }, send: { state: 'sent' } } })

    expect(await claimOf(service, id)).toMatchObject({ decision: 'reply', private_state: 'sent', public_state: 'posted', dm_conversation_id: dm.id })

    // Nothing of the comment, the commenter or the opener in the log; the identity answer as a boolean
    const logged = output()
    for (const secret of [COMMENT_TEXT, COMMENTER, USERNAME, RECIPIENT_IGSID, TOKEN, 'شفنا تعليقك']) expect(logged).not.toContain(secret)
    expect(logged).toContain('recipientIsCommenter')
  })

  it('THE SAME COMMENT TWICE IS ONE PRIVATE REPLY AND ONE PUBLIC REPLY', async () => {
    const { service, channelId, accountId } = await liveAccount()
    consoleOutput()
    meta()

    const { id } = await deliverComment(accountId)
    await deliverComment(accountId, { id })
    // And a third time, as a boosted post's duplicate notification can
    await deliverComment(accountId, { id })

    expect(graphCalls.filter(isPrivate)).toHaveLength(1)
    expect(graphCalls.filter(isPublic)).toHaveLength(1)
    const thread = (await conversationsOf(service, channelId)).find((c) => c.thread === 'comments')!
    expect((await rowsOf(service, thread.id)).filter((m) => m.role === 'assistant')).toHaveLength(1)
  })

  it('a private reply that fails: the public reply is the invite, which promises nothing', async () => {
    const { service, accountId } = await liveAccount()
    consoleOutput()
    meta({ privateFails: true })

    const { id } = await deliverComment(accountId)

    const publicCalls = graphCalls.filter(isPublic)
    expect(publicCalls).toHaveLength(1)
    expect(publicCalls[0].body).toEqual({ message: COMMENT_PUBLIC_INVITE_AR })
    expect(await claimOf(service, id)).toMatchObject({ private_state: 'failed:failed', public_variant: 'invite', public_state: 'posted', dm_conversation_id: null })
  })

  it('a public reply that fails is attempted once, never retried, and logged; the private reply stands', async () => {
    const { service, accountId } = await liveAccount()
    consoleOutput()
    meta({ publicFails: true })

    const { id } = await deliverComment(accountId)

    expect(graphCalls.filter(isPublic)).toHaveLength(1)
    expect(await claimOf(service, id)).toMatchObject({ private_state: 'sent', public_state: 'failed:failed' })
  })

  it('one public reply per person per post, ever, and no second opener: a later comment on the same post gets silence', async () => {
    const { service, accountId } = await liveAccount()
    consoleOutput()
    meta()

    await deliverComment(accountId)
    const { id: second } = await deliverComment(accountId, { text: 'وكمان سؤال تاني' })
    const { id: third } = await deliverComment(accountId, { text: 'ولا حد هيرد؟' })

    expect(graphCalls.filter(isPrivate)).toHaveLength(1)
    expect(graphCalls.filter(isPublic)).toHaveLength(1)
    expect(await claimOf(service, second)).toMatchObject({ private_state: 'skipped:already_opened', public_state: 'skipped:already_replied_on_post' })
    expect(await claimOf(service, third)).toMatchObject({ private_state: 'skipped:already_opened', public_state: 'skipped:already_replied_on_post' })
  })

  it('the same person on another post: that post’s one public reply is the INVITE, never set A, since nothing was sent privately for it; no second opener', async () => {
    const { accountId } = await liveAccount()
    consoleOutput()
    meta()

    await deliverComment(accountId)
    await deliverComment(accountId, { mediaId: 'MEDIA-2' })

    expect(graphCalls.filter(isPrivate)).toHaveLength(1)
    const publicCalls = graphCalls.filter(isPublic)
    expect(publicCalls).toHaveLength(2)
    // The first comment's private reply went: set A is true for it
    expect(COMMENT_PUBLIC_SENT_AR).toContain(publicCalls[0].body.message)
    // Nothing was sent privately for the second: claiming so would be untrue in public (2026-11-09)
    expect(publicCalls[1].body.message).toBe(COMMENT_PUBLIC_INVITE_AR)
  })
})

describe('what is never answered', () => {
  it('our own public reply, delivered back: known by the id we recorded', async () => {
    const { service, accountId } = await liveAccount()
    consoleOutput()
    meta()
    await deliverComment(accountId)
    const { data: claim } = await service.from('meta_comment_replies').select('public_comment_id, public_variant').not('public_comment_id', 'is', null).limit(1).single<{ public_comment_id: string; public_variant: string }>()
    graphCalls.length = 0

    // Instagram delivers our reply as a comment, with an author id that is not the account's
    const { id } = await deliverComment(accountId, { id: claim!.public_comment_id, text: 'anything', fromId: '17900000000009999' })

    expect(graphCalls).toHaveLength(0)
    expect(await claimOf(service, id)).toMatchObject({ decision: 'own_reply' })
  })

  it('our own public reply arriving before its id was recorded: known by being exactly one of our strings', async () => {
    const { service, accountId } = await liveAccount()
    consoleOutput()
    meta()

    const { id } = await deliverComment(accountId, { text: COMMENT_PUBLIC_SENT_AR[1], fromId: '17900000000009999' })

    expect(graphCalls).toHaveLength(0)
    expect(await claimOf(service, id)).toMatchObject({ decision: 'own_text' })
  })

  it('a comment by the account itself (a person at the clinic): not answered', async () => {
    const { service, accountId } = await liveAccount()
    consoleOutput()
    meta()

    const { id } = await deliverComment(accountId, { fromId: accountId, text: 'أهلاً بالجميع' })

    expect(graphCalls).toHaveLength(0)
    expect(await claimOf(service, id)).toMatchObject({ decision: 'own_account' })
  })

  it('a reply inside a comment thread: stored, not answered', async () => {
    const { service, channelId, accountId } = await liveAccount()
    consoleOutput()
    meta()

    const { id } = await deliverComment(accountId, { parentId: 'C-PARENT', text: 'شكراً' })

    expect(graphCalls).toHaveLength(0)
    expect(await claimOf(service, id)).toMatchObject({ decision: 'reply_in_thread' })
    const thread = (await conversationsOf(service, channelId)).find((c) => c.thread === 'comments')!
    expect((await rowsOf(service, thread.id)).map((m) => m.role)).toEqual(['user'])
  })

  it('a mention (a comment on someone else’s media tagging the account): never a comment here', async () => {
    const { service, channelId, accountId } = await liveAccount()
    consoleOutput()
    meta()

    await deliverComment(accountId, { field: 'mentions' })

    expect(graphCalls).toHaveLength(0)
    expect(await conversationsOf(service, channelId)).toEqual([])
  })

  it('the channel’s switch off, as every channel is by default: nothing stored, nothing claimed, nothing sent', async () => {
    const { service, channelId, accountId, clientId } = await liveAccount({ switchedOn: false })
    consoleOutput()
    meta()
    const { data: row } = await service.from('channels').select('comment_replies_enabled').eq('id', channelId).single<{ comment_replies_enabled: boolean }>()
    expect(row!.comment_replies_enabled).toBe(false)

    const { id } = await deliverComment(accountId)

    expect(graphCalls).toHaveLength(0)
    expect(await conversationsOf(service, channelId)).toEqual([])
    expect(await claimOf(service, id)).toBeNull()
  })
})

describe('the opener', () => {
  it('carries the clinic’s name; with none, the phrase is dropped whole: no empty braces, no substitute', () => {
    expect(openerFor('عيادة النور').split('\n')[0]).toBe('أهلاً بيك في عيادة النور 🌸')
    expect(openerFor(null).split('\n')[0]).toBe('أهلاً بيك 🌸')
    expect(openerFor('   ').split('\n')[0]).toBe('أهلاً بيك 🌸')
    expect(openerFor(null)).not.toContain('{{')
    expect(openerFor(null).split('\n').slice(1)).toEqual(COMMENT_PRIVATE_OPENER_AR.split('\n').slice(1))
  })
})
