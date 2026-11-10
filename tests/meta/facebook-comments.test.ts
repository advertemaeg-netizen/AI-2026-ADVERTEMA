import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../app/api/webhook/meta/route'
import { COMMENT_PUBLIC_INVITE_AR, COMMENT_PUBLIC_SENT_AR } from '@/lib/meta/comment-strings-ar'
import { WHATSAPP_PLACEHOLDER_AR } from '@/lib/meta/whatsapp-notices-ar'
import { fromFacebook, fromInstagram } from '@/lib/meta/comments'
import { inboundFacebookComments } from '@/lib/meta/webhook'
import { flushAfter, geminiCalls, graphCalls, mockGemini, mockGraph, seedClient, serviceClient, type GraphCall } from '../harness/helpers'
import { geminiWorks } from '../leads/webhook'

/**
 * FACEBOOK PAGE COMMENTS, THROUGH THE ONE COMMENT PATH (.scratch/facebook-comments-brief.md).
 *
 * The coordinator is Instagram's (src/lib/meta/comments.ts): claim, ours?,
 * store, a private reply first, then one fixed public reply per person per
 * post. What Facebook adds is in its platform object, and these hold it:
 *   - only `feed` changes that ADD a comment are comments; everything else on
 *     `feed` (posts, reactions, edits, hides…) does nothing;
 *   - a top-level comment's parent_id is its post's id (the Instagram rule
 *     would skip every Page comment: guarded below);
 *   - never a reply on a post that is not the Page's own, read once per post
 *     and kept; unknown is never ours;
 *   - never a reply to a hidden comment (the clinic's moderation); stored all
 *     the same, with the reason;
 *   - the private reply opens the person's Messenger conversation, keyed by
 *     the PSID Meta answers with, named after the commenter; their Messenger
 *     message lands in it.
 * Nothing here reads order from created_at.
 */

const APP_SECRET = 'app-secret-for-tests'
const TOKEN = 'EAAG-facebook-comments-token'

beforeEach(() => {
  vi.stubEnv('META_VERIFY_TOKEN', 'verify-token-for-tests')
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
  for (const level of ['info', 'warn', 'error'] as const) vi.spyOn(console, level).mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const service = serviceClient()

async function livePage({ switchedOn = true } = {}) {
  const seeded = await seedClient()
  const pageId = `${Date.now()}${Math.floor(Math.random() * 1000)}`
  const { data: channel, error } = await service.from('channels').insert({ client_id: seeded.clientId, type: 'facebook', name: 'Facebook', external_id: pageId }).select('id').single<{ id: string }>()
  if (error) throw error
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: channel.id, access_token: TOKEN })
  if (secretError) throw secretError
  if (switchedOn) await service.from('clients').update({ comment_replies_enabled: true }).eq('id', seeded.clientId)
  return { ...seeded, pageId, channelId: channel.id }
}

const newPsid = () => `9${crypto.randomUUID().replace(/\D/g, '').padEnd(16, '7').slice(0, 16)}`
const objectId = () => `${crypto.randomUUID().replace(/\D/g, '').padEnd(15, '3').slice(0, 15)}`

/** Graph as the Page answers: who wrote each post, whether each comment is hidden, the sends */
function graph({
  pageId,
  psid,
  postAuthor = () => pageId,
  hidden = () => false,
  message = () => undefined,
}: {
  pageId: string
  psid: string
  postAuthor?: (postId: string) => string | null
  hidden?: (commentId: string) => boolean | null
  /** What GET /{comment}?fields=is_hidden,message answers as the comment's text */
  message?: (commentId: string) => string | undefined
}) {
  mockGraph((call: GraphCall) => {
    const path = decodeURIComponent(new URL(call.url).pathname.replace(/^\/v\d+\.\d+\//, ''))
    if (call.method === 'GET' && call.url.includes('fields=from')) {
      const author = postAuthor(path)
      return author === null ? Response.json({ error: { code: 100 } }, { status: 400 }) : Response.json({ id: path, from: { id: author, name: 'x' } })
    }
    if (call.method === 'GET' && call.url.includes('fields=is_hidden')) {
      const value = hidden(path)
      const text = message(path)
      return value === null ? Response.json({ error: { code: 100 } }, { status: 400 }) : Response.json({ id: path, is_hidden: value, ...(text !== undefined ? { message: text } : {}) })
    }
    if (call.url.endsWith('/comments')) return Response.json({ id: `${path.split('_')[0]}_reply${objectId()}` })
    return Response.json({ recipient_id: psid, message_id: `m_OPENER_${crypto.randomUUID()}` })
  })
}

async function deliver(pageId: string, changes: Record<string, unknown>[] = [], messaging: Record<string, unknown>[] = []) {
  const body = JSON.stringify({ object: 'page', entry: [{ id: pageId, time: 1792569600, ...(changes.length ? { changes } : {}), ...(messaging.length ? { messaging } : {}) }] })
  const request = new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
    body,
  })
  await POST(request)
  await flushAfter()
}

type Comment = { postId: string; commentId?: string; parentId?: string; from: { id: string; name?: string }; message?: string; verb?: string; item?: string }
function feedChange({ postId, commentId = `${postId.split('_')[1]}_${objectId()}`, parentId = postId, from, message, verb = 'add', item = 'comment' }: Comment) {
  return { field: 'feed', value: { item, verb, comment_id: commentId, post_id: postId, parent_id: parentId, from, message, created_time: 1792569600 } }
}

async function claimOf(commentId: string) {
  const { data } = await service.from('meta_comment_replies').select('decision, private_state, public_state, public_comment_id, private_message_id').eq('comment_id', commentId).maybeSingle()
  return data as { decision: string | null; private_state: string | null; public_state: string | null; public_comment_id: string | null; private_message_id: string | null } | null
}

async function threads(channelId: string, contact: string) {
  const { data } = await service.from('conversations').select('id, thread, contact_name').eq('channel_id', channelId).eq('contact_identifier', contact)
  return (data ?? []) as { id: string; thread: string; contact_name: string | null }[]
}

async function rows(conversationId: string) {
  const { data } = await service.from('messages').select('role, content, metadata').eq('conversation_id', conversationId)
  return (data ?? []) as { role: string; content: string; metadata: Record<string, unknown> | null }[]
}

/** The comment exactly as the live feed webhook carries it: no message (review clinic's Page, 2026-11-09) */
function liveFeedChange(postId: string, from: { id: string; name: string }) {
  const change = feedChange({ postId, from })
  const { message: _absent, ...value } = change.value
  void _absent
  return { field: 'feed', value }
}

const commentReads = () => graphCalls.filter((c) => c.method === 'GET' && c.url.includes('fields=is_hidden'))
const privateSends = () => graphCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages'))
const publicSends = () => graphCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/comments'))
const authorReads = () => graphCalls.filter((c) => c.method === 'GET' && c.url.includes('fields=from'))

describe('a comment on the Page’s own post', () => {
  it('gets the private reply first, which opens the person’s Messenger conversation, named after them; then one fixed public reply', async () => {
    const { pageId, channelId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid })
    const change = feedChange({ postId, from: { id: psid, name: 'Ahmed Shabrawy' }, message: 'بكام التبييض؟' })

    await deliver(pageId, [change])

    const commentId = change.value.comment_id
    expect(await claimOf(commentId)).toMatchObject({ decision: 'reply', private_state: 'sent', public_state: 'posted' })
    // The private reply first, to the comment, on the Page's messages endpoint
    expect(graphCalls.findIndex((c) => c.url.endsWith('/messages'))).toBeLessThan(graphCalls.findIndex((c) => c.url.endsWith('/comments')))
    expect(privateSends()[0].url).toBe(`https://graph.facebook.com/v25.0/${pageId}/messages`)
    expect(privateSends()[0].body).toMatchObject({ recipient: { comment_id: commentId } })
    expect(publicSends()[0].url).toBe(`https://graph.facebook.com/v25.0/${commentId}/comments`)
    expect([...COMMENT_PUBLIC_SENT_AR]).toContain(publicSends()[0].body.message)

    const [comments, dm] = [(await threads(channelId, psid)).find((t) => t.thread === 'comments')!, (await threads(channelId, psid)).find((t) => t.thread === 'dm')!]
    expect(comments.contact_name).toBe('Ahmed Shabrawy')
    expect(dm.contact_name).toBe('Ahmed Shabrawy')
    const opener = (await rows(dm.id)).find((r) => r.role === 'assistant')!
    expect(opener.metadata).toMatchObject({ transport: 'messenger', send: { transport: 'messenger', state: 'sent' } })
    const publicRow = (await rows(comments.id)).find((r) => r.role === 'assistant')!
    expect(publicRow.metadata).toMatchObject({ transport: 'facebook', commentReply: { commentId, postId } })
    // The post's author is kept: a post's author never changes
    const { data: cached } = await service.from('meta_post_authors').select('page_owned').eq('post_id', postId).single<{ page_owned: boolean }>()
    expect(cached!.page_owned).toBe(true)
  })

  it('the person’s later Messenger message lands in the conversation the private reply opened: one patient, one DM', async () => {
    const { pageId, channelId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid })
    mockGemini(geminiWorks)
    await deliver(pageId, [feedChange({ postId, from: { id: psid, name: 'Ahmed' }, message: 'السعر؟' })])

    await deliver(pageId, [], [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: 1792569601000, message: { mid: `m_${crypto.randomUUID()}`, text: 'عايز أحجز' } }])

    const dms = (await threads(channelId, psid)).filter((t) => t.thread === 'dm')
    expect(dms).toHaveLength(1)
    expect((await rows(dms[0].id)).filter((r) => r.role === 'user').map((r) => r.content)).toEqual(['عايز أحجز'])
  })

  it('a second comment by the same person on the same post: no second opener, no second public reply', async () => {
    const { pageId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid })
    await deliver(pageId, [feedChange({ postId, from: { id: psid, name: 'A' }, message: 'أول' })])
    const second = feedChange({ postId, from: { id: psid, name: 'A' }, message: 'تاني' })

    await deliver(pageId, [second])

    expect(await claimOf(second.value.comment_id)).toMatchObject({ private_state: 'skipped:already_opened', public_state: 'skipped:already_replied_on_post' })
    expect(privateSends()).toHaveLength(1)
    expect(publicSends()).toHaveLength(1)
    expect(authorReads()).toHaveLength(1)
  })
})

describe('set A only when a private message was sent for this comment (2026-11-09)', () => {
  it('the same person on another post: nothing sent privately, so the public reply is the invite, never a claim that we messaged them', async () => {
    const { pageId } = await livePage()
    const psid = newPsid()
    graph({ pageId, psid })
    await deliver(pageId, [feedChange({ postId: `${pageId}_${objectId()}`, from: { id: psid, name: 'A' }, message: 'أول' })])
    await deliver(pageId, [feedChange({ postId: `${pageId}_${objectId()}`, from: { id: psid, name: 'A' }, message: 'تاني' })])

    expect(privateSends()).toHaveLength(1)
    const [first, second] = publicSends().map((c) => c.body.message)
    expect([...COMMENT_PUBLIC_SENT_AR]).toContain(first)
    expect(second).toBe(COMMENT_PUBLIC_INVITE_AR)
  })
})

describe('the comment’s text, which the feed webhook does not carry', () => {
  it('is read with is_hidden in one call, stored as written, and the comment answered', async () => {
    const { pageId, channelId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid, message: () => 'بكام تبييض الأسنان؟' })
    const change = liveFeedChange(postId, { id: psid, name: 'Ahmed' })
    expect(Object.keys(change.value).sort()).toEqual(['comment_id', 'created_time', 'from', 'item', 'parent_id', 'post_id', 'verb'])

    await deliver(pageId, [change])

    const thread = (await threads(channelId, psid)).find((t) => t.thread === 'comments')!
    expect((await rows(thread.id)).filter((r) => r.role === 'user').map((r) => r.content)).toEqual(['بكام تبييض الأسنان؟'])
    expect(commentReads()).toHaveLength(1)
    expect(commentReads()[0].url).toContain('fields=is_hidden,message')
    expect(await claimOf(change.value.comment_id as string)).toMatchObject({ decision: 'reply', private_state: 'sent' })
  })

  it('a read that fails: still stored, with the placeholder, and not answered (as before the read existed)', async () => {
    const { pageId, channelId } = await livePage()
    const psid = newPsid()
    graph({ pageId, psid, hidden: () => null })
    const change = liveFeedChange(`${pageId}_${objectId()}`, { id: psid, name: 'A' })

    await deliver(pageId, [change])

    const thread = (await threads(channelId, psid)).find((t) => t.thread === 'comments')!
    expect((await rows(thread.id)).map((r) => r.content)).toEqual([WHATSAPP_PLACEHOLDER_AR.unsupported])
    expect(await claimOf(change.value.comment_id as string)).toMatchObject({ decision: 'hidden_unchecked' })
    expect(privateSends()).toHaveLength(0)
  })

  it('a read that answers without a message: the placeholder stands and the comment is answered as before', async () => {
    const { pageId } = await livePage()
    const psid = newPsid()
    graph({ pageId, psid, message: () => undefined })
    const change = liveFeedChange(`${pageId}_${objectId()}`, { id: psid, name: 'A' })

    await deliver(pageId, [change])

    expect(await claimOf(change.value.comment_id as string)).toMatchObject({ decision: 'reply', private_state: 'sent' })
  })

  it('a comment that is not answered (on someone else’s post) still shows what was written', async () => {
    const { pageId, channelId } = await livePage()
    const psid = newPsid()
    graph({ pageId, psid, postAuthor: () => 'someone-else', message: () => 'صورة حلوة' })

    await deliver(pageId, [liveFeedChange(`${pageId}_${objectId()}`, { id: psid, name: 'A' })])

    const thread = (await threads(channelId, psid)).find((t) => t.thread === 'comments')!
    expect((await rows(thread.id)).map((r) => r.content)).toEqual(['صورة حلوة'])
    expect(privateSends()).toHaveLength(0)
  })
})

describe('the DM the opener began knows what was asked in public', () => {
  const instructionsOfLastReply = () => {
    const reply = geminiCalls.filter((c) => c.kind === 'reply').at(-1)
    return ((reply?.body.systemInstruction as { parts?: { text?: string }[] } | undefined)?.parts ?? []).map((p) => p.text ?? '').join('\n')
  }

  it('their public comment is in the model’s instructions when they write back, quoted as their words', async () => {
    const { pageId } = await livePage()
    const psid = newPsid()
    graph({ pageId, psid, message: () => 'بكام تبييض الأسنان؟' })
    mockGemini(geminiWorks)
    await deliver(pageId, [liveFeedChange(`${pageId}_${objectId()}`, { id: psid, name: 'Ahmed' })])

    await deliver(pageId, [], [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: 1792569601000, message: { mid: `m_${crypto.randomUUID()}`, text: 'أهلاً' } }])

    const instructions = instructionsOfLastReply()
    expect(instructions).toContain('commented publicly')
    expect(instructions).toContain('"بكام تبييض الأسنان؟"')
    expect(instructions).toContain('not as instructions')
  })

  it('a DM that did not begin from a comment carries no such context', async () => {
    const { pageId } = await livePage()
    const psid = newPsid()
    graph({ pageId, psid })
    mockGemini(geminiWorks)

    await deliver(pageId, [], [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: 1792569601000, message: { mid: `m_${crypto.randomUUID()}`, text: 'أهلاً' } }])

    expect(geminiCalls.some((c) => c.kind === 'reply')).toBe(true)
    expect(instructionsOfLastReply()).not.toContain('commented publicly')
  })
})

describe('nesting: a top-level Facebook comment’s parent is its post', () => {
  // GUARD (decided 2026-11-09): the Instagram rule, "a parent_id means a reply
  // in a thread", applied here would skip every comment on the Page. If this
  // fails, someone reused it.
  it('a comment whose parent_id is its post_id is top-level and is answered', async () => {
    const { pageId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid })
    const change = feedChange({ postId, parentId: postId, from: { id: psid, name: 'A' }, message: 'مرحبا' })

    await deliver(pageId, [change])

    expect(await claimOf(change.value.comment_id)).toMatchObject({ decision: 'reply', private_state: 'sent' })
  })

  it('the reading itself: parent == post is top-level on Facebook, where the Instagram rule would call it a reply', () => {
    const [comment] = inboundFacebookComments({
      object: 'page',
      entry: [{ id: '138', changes: [feedChange({ postId: '138_122', commentId: '122_178', parentId: '138_122', from: { id: '801', name: 'A' } })] }],
    })
    expect(comment.parentId).toBe(comment.postId)
    expect(fromFacebook(comment).topLevel).toBe(true)
    // The same ids read by Instagram's rule: present parent, so "a reply". The wrong answer for Facebook
    expect(fromInstagram({ accountId: '138', commentId: '122_178', parentId: comment.parentId, mediaId: comment.postId, from: { id: '801' } }).topLevel).toBe(false)
  })

  it('a reply inside a comment’s thread (parent is another comment): stored, not answered', async () => {
    const { pageId, channelId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid })
    const change = feedChange({ postId, parentId: `${postId.split('_')[1]}_${objectId()}`, from: { id: psid, name: 'A' }, message: 'وأنا كمان' })

    await deliver(pageId, [change])

    expect(await claimOf(change.value.comment_id)).toMatchObject({ decision: 'reply_in_thread' })
    // Read once, so the inbox shows what was written; nothing sent
    expect(commentReads()).toHaveLength(1)
    expect(privateSends()).toHaveLength(0)
    expect(publicSends()).toHaveLength(0)
    const thread = (await threads(channelId, psid)).find((t) => t.thread === 'comments')!
    expect((await rows(thread.id)).map((r) => r.content)).toEqual(['وأنا كمان'])
  })
})

describe('never a reply on a post that is not the Page’s own', () => {
  it('a visitor’s post: stored with the reason, nothing sent, and its author read once', async () => {
    const { pageId, channelId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid, postAuthor: () => 'someone-else' })
    const first = feedChange({ postId, from: { id: psid, name: 'A' }, message: 'واو' })
    const second = feedChange({ postId, from: { id: newPsid(), name: 'B' }, message: 'فعلاً' })

    await deliver(pageId, [first])
    await deliver(pageId, [second])

    expect(await claimOf(first.value.comment_id)).toMatchObject({ decision: 'not_own_post' })
    expect(await claimOf(second.value.comment_id)).toMatchObject({ decision: 'not_own_post' })
    expect(privateSends()).toHaveLength(0)
    expect(publicSends()).toHaveLength(0)
    expect(authorReads()).toHaveLength(1)
    const thread = (await threads(channelId, psid)).find((t) => t.thread === 'comments')!
    expect((await rows(thread.id)).map((r) => r.content)).toEqual(['واو'])
  })

  it('an author that cannot be read is never taken as ours, and is asked again next time', async () => {
    const { pageId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid, postAuthor: () => null })
    const first = feedChange({ postId, from: { id: psid, name: 'A' }, message: 'سؤال' })

    await deliver(pageId, [first])
    await deliver(pageId, [feedChange({ postId, from: { id: newPsid(), name: 'B' }, message: 'سؤال تاني' })])

    expect(await claimOf(first.value.comment_id)).toMatchObject({ decision: 'post_unchecked' })
    expect(privateSends()).toHaveLength(0)
    expect(authorReads()).toHaveLength(2)
    const { data: cached } = await service.from('meta_post_authors').select('post_id').eq('post_id', postId)
    expect(cached).toEqual([])
  })
})

describe('never a reply to a hidden comment: the clinic’s moderation stands', () => {
  it('hidden (by the clinic, or its Page’s filters on arrival): stored with the reason, no private message, no public reply', async () => {
    const { pageId, channelId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid, hidden: () => true })
    const change = feedChange({ postId, from: { id: psid, name: 'A' }, message: 'كلام مش لطيف' })

    await deliver(pageId, [change])

    expect(await claimOf(change.value.comment_id)).toMatchObject({ decision: 'hidden' })
    expect(privateSends()).toHaveLength(0)
    expect(publicSends()).toHaveLength(0)
    const thread = (await threads(channelId, psid)).find((t) => t.thread === 'comments')!
    expect((await rows(thread.id)).map((r) => r.content)).toEqual(['كلام مش لطيف'])
  })

  it('a hidden state that cannot be read: nothing sent', async () => {
    const { pageId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid, hidden: () => null })
    const change = feedChange({ postId, from: { id: psid, name: 'A' }, message: 'سؤال' })

    await deliver(pageId, [change])

    expect(await claimOf(change.value.comment_id)).toMatchObject({ decision: 'hidden_unchecked' })
    expect(privateSends()).toHaveLength(0)
  })
})

describe('the Page’s own comments, and our replies coming back', () => {
  it('a comment by the Page is never answered', async () => {
    const { pageId } = await livePage()
    graph({ pageId, psid: newPsid() })
    const postId = `${pageId}_${objectId()}`
    const change = feedChange({ postId, from: { id: pageId, name: 'العيادة' }, message: 'شكراً' })

    await deliver(pageId, [change])

    expect(await claimOf(change.value.comment_id)).toMatchObject({ decision: 'own_account' })
    expect(graphCalls).toHaveLength(0)
  })

  it('our public reply, delivered back on feed, is known by the id we recorded', async () => {
    const { pageId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid })
    const change = feedChange({ postId, from: { id: psid, name: 'A' }, message: 'السعر؟' })
    await deliver(pageId, [change])
    const replyId = (await claimOf(change.value.comment_id))!.public_comment_id!
    const calls = graphCalls.length

    // Not by its author: the recorded id decides first
    await deliver(pageId, [feedChange({ postId, commentId: replyId, parentId: change.value.comment_id, from: { id: newPsid(), name: 'x' }, message: COMMENT_PUBLIC_INVITE_AR + ' ' })])

    expect(await claimOf(replyId)).toMatchObject({ decision: 'own_reply' })
    expect(graphCalls).toHaveLength(calls)
  })
})

describe('everything else on feed', () => {
  it('posts, reactions, and a comment’s edits, removals and hides do nothing at all', async () => {
    const { pageId, channelId } = await livePage()
    const psid = newPsid()
    const postId = `${pageId}_${objectId()}`
    graph({ pageId, psid })
    const ignored = [
      feedChange({ postId, from: { id: psid }, message: 'تعديل', verb: 'edited' }),
      feedChange({ postId, from: { id: psid }, verb: 'remove' }),
      feedChange({ postId, from: { id: psid }, verb: 'hide' }),
      feedChange({ postId, from: { id: psid }, verb: 'unhide' }),
      { field: 'feed', value: { item: 'reaction', verb: 'add', post_id: postId, reaction_type: 'like', from: { id: psid } } },
      { field: 'feed', value: { item: 'status', verb: 'add', post_id: postId, message: 'منشور', from: { id: pageId } } },
      { field: 'feed', value: { item: 'post', verb: 'add', post_id: `${pageId}_${objectId()}`, message: 'منشور زائر', from: { id: psid } } },
    ]

    await deliver(pageId, ignored)

    expect(graphCalls).toHaveLength(0)
    expect(await threads(channelId, psid)).toEqual([])
    const { data: claims } = await service.from('meta_comment_replies').select('comment_id').eq('channel_id', channelId)
    expect(claims).toEqual([])
  })

  it('with the client’s switch off, a comment is not stored, claimed or answered', async () => {
    const { pageId, channelId } = await livePage({ switchedOn: false })
    const psid = newPsid()
    graph({ pageId, psid })

    await deliver(pageId, [feedChange({ postId: `${pageId}_${objectId()}`, from: { id: psid, name: 'A' }, message: 'مرحبا' })])

    expect(graphCalls).toHaveLength(0)
    expect(await threads(channelId, psid)).toEqual([])
  })
})
