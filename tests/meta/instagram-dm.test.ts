import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../app/api/webhook/meta/route'
import { buildSystemPrompt } from '@/lib/ai/bot'
import { WHATSAPP_PLACEHOLDER_AR, WHATSAPP_UNSUPPORTED_AR } from '@/lib/meta/whatsapp-notices-ar'
import type { BotSettingsInput } from '@/lib/types/bot-settings'
import { flushAfter, graphCalls, mockGemini, mockGraph, seedClient, serviceClient, type GraphCall } from '../harness/helpers'
import { botReply, geminiWorks } from '../leads/webhook'

/**
 * INSTAGRAM DIRECT MESSAGES GO THROUGH THE PIPELINE WE HAVE
 * (.scratch/instagram-dm-inbound-brief.md; .scratch/agent-reply-decisions.md §3).
 *
 * Until now an Instagram DM was claimed and dropped: the comment opener
 * invited the person to write back, and their answer reached nothing. Now:
 *   - a DM is stored and answered as a WhatsApp message is: no welcome
 *     message, a cold DM straight into the pipeline, the reply through the
 *     Instagram send;
 *   - a DM after the opener lands in the conversation the opener opened;
 *   - the conversation is named: from the person's comment thread, else the
 *     profile, fetched once; never two names for one patient;
 *   - typed words are never dropped: a shared post or reel with words goes to
 *     the pipeline, a placeholder is for a message with nothing to read (and
 *     the same now holds on Messenger, where an image's words were dropped);
 *   - story mentions are left (out of this build);
 *   - the account's echoes are told apart by the ids we recorded, as on
 *     Messenger: the opener's own is ours, anything else is a person at the
 *     clinic answering from the Instagram app, and the bot stands down.
 * Nothing here reads order from created_at.
 */

const APP_SECRET = 'app-secret-for-tests'
const TOKEN = 'EAAG-instagram-dm-token'

beforeEach(() => {
  vi.stubEnv('META_VERIFY_TOKEN', 'verify-token-for-tests')
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const service = serviceClient()

function consoleOutput() {
  const spies = (['info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

async function liveAccount({ comments = false } = {}) {
  const seeded = await seedClient()
  const accountId = `1784${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`
  const { data: channel, error } = await service.from('channels').insert({ client_id: seeded.clientId, type: 'instagram', name: 'Instagram', external_id: accountId }).select('id').single<{ id: string }>()
  if (error) throw error
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: channel.id, access_token: TOKEN })
  if (secretError) throw secretError
  if (comments) await service.from('channels').update({ comment_replies_enabled: true }).eq('id', channel.id)
  return { ...seeded, accountId, channelId: channel.id }
}

const newPerson = () => `IGSID${crypto.randomUUID().replace(/-/g, '').slice(0, 14)}`

/** Graph as the tests need it: the profile (a username, or a refusal), the DM send, the private and public replies */
function graph({ username, recipient }: { username?: string | null; recipient?: string } = {}) {
  mockGraph((call: GraphCall) => {
    if (call.method === 'GET') {
      return username ? Response.json({ username, id: 'x' }) : Response.json({ error: { code: 230, message: 'never logged' } }, { status: 400 })
    }
    if (call.url.endsWith('/replies')) return Response.json({ id: `reply-${crypto.randomUUID()}` })
    return Response.json({ recipient_id: recipient ?? (call.body.recipient as { id?: string })?.id ?? 'x', message_id: `m_OUT_${crypto.randomUUID()}` })
  })
}

async function deliver(object: 'instagram' | 'page', entry: Record<string, unknown>) {
  const body = JSON.stringify({ object, entry: [entry] })
  const request = new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
    body,
  })
  await POST(request)
  await flushAfter()
}

function dm(accountId: string, from: string, message: Record<string, unknown>) {
  return deliver('instagram', { id: accountId, time: 1792569600000, messaging: [{ sender: { id: from }, recipient: { id: accountId }, timestamp: 1792569600000, message: { mid: `m_${crypto.randomUUID()}`, ...message } }] })
}

function comment(accountId: string, from: string, username: string, text: string) {
  return deliver('instagram', {
    id: accountId,
    time: 1792569600,
    changes: [{ field: 'comments', value: { id: `comment-${crypto.randomUUID()}`, text, from: { id: from, username }, media: { id: 'media-1', media_product_type: 'FEED' } } }],
  })
}

type Conversation = { id: string; thread: string; contact_name: string | null }
async function conversationsOf(channelId: string, contact: string) {
  const { data } = await service.from('conversations').select('id, thread, contact_name').eq('channel_id', channelId).eq('contact_identifier', contact)
  return (data ?? []) as Conversation[]
}
const dmOf = async (channelId: string, contact: string) => (await conversationsOf(channelId, contact)).find((c) => c.thread === 'dm')

type Row = { role: string; content: string; metadata: Record<string, unknown> | null }
async function rowsOf(conversationId: string) {
  const { data } = await service.from('messages').select('role, content, metadata').eq('conversation_id', conversationId)
  return (data ?? []) as Row[]
}

const sends = () => graphCalls.filter((c) => c.method === 'POST' && c.url.endsWith('/messages') && (c.body.recipient as { id?: string })?.id)
const profileFetches = () => graphCalls.filter((c) => c.method === 'GET')

describe('a cold Instagram DM', () => {
  it('opens the person’s conversation and is answered through the pipeline by the Instagram send, with no welcome message', async () => {
    const { accountId, channelId } = await liveAccount()
    const person = newPerson()
    const output = consoleOutput()
    mockGemini(geminiWorks)
    graph({ username: 'patient.one' })

    await dm(accountId, person, { text: 'بكام التنظيف؟' })

    const conversation = await dmOf(channelId, person)
    expect(conversation).toBeDefined()
    const rows = await rowsOf(conversation!.id)
    expect(rows.filter((r) => r.role === 'user').map((r) => r.content)).toEqual(['بكام التنظيف؟'])
    // One reply and nothing before it: no welcome message
    const replies = rows.filter((r) => r.role === 'assistant')
    expect(replies).toHaveLength(1)
    expect(replies[0].metadata?.send).toMatchObject({ transport: 'instagram', state: 'sent' })
    expect(sends()).toHaveLength(1)
    expect(sends()[0].url).toBe(`https://graph.facebook.com/v26.0/${accountId}/messages`)
    expect(sends()[0].body).toMatchObject({ recipient: { id: person }, message: { text: replies[0].content } })
    // Named from the profile, fetched once; the username is never logged
    expect(conversation!.contact_name).toBe('patient.one')
    expect(profileFetches()).toHaveLength(1)
    expect(profileFetches()[0].url).toBe(`https://graph.facebook.com/v26.0/${person}?fields=username`)
    expect(output()).not.toContain('patient.one')
    expect(output()).not.toContain('بكام التنظيف؟')
  })

  it('keeps "visitor" plus the id when the profile cannot be read, and does not ask again on the next message', async () => {
    const { accountId, channelId } = await liveAccount()
    const person = newPerson()
    consoleOutput()
    mockGemini(geminiWorks)
    graph({ username: null })

    await dm(accountId, person, { text: 'مرحبا' })
    await dm(accountId, person, { text: 'حد هنا؟' })

    expect((await dmOf(channelId, person))?.contact_name).toBeNull()
    expect(profileFetches()).toHaveLength(1)
    expect(sends()).toHaveLength(2)
  })
})

describe('the conversation’s name', () => {
  it('a person with a comment thread: their DM takes its username, and the profile is not fetched', async () => {
    const { accountId, channelId, clientId } = await liveAccount()
    const person = newPerson()
    consoleOutput()
    await service.from('conversations').insert({ client_id: clientId, channel_id: channelId, contact_identifier: person, contact_name: 'commenter.one', thread: 'comments', status: 'new', auto_reply_enabled: false })
    mockGemini(geminiWorks)
    graph({ username: 'never-used' })

    await dm(accountId, person, { text: 'مرحبا' })

    expect((await dmOf(channelId, person))?.contact_name).toBe('commenter.one')
    expect(profileFetches()).toHaveLength(0)
  })

  it('a DM conversation with no name: filled from the comment thread on the next DM, and a name is never replaced', async () => {
    const { accountId, channelId, clientId } = await liveAccount()
    const person = newPerson()
    consoleOutput()
    const { data: nameless } = await service.from('conversations').insert({ client_id: clientId, channel_id: channelId, contact_identifier: person, thread: 'dm', status: 'new' }).select('id').single<{ id: string }>()
    await service.from('conversations').insert({ client_id: clientId, channel_id: channelId, contact_identifier: person, contact_name: 'ahmedshabrawy3', thread: 'comments', status: 'new', auto_reply_enabled: false })
    mockGemini(geminiWorks)
    graph({ username: 'never-used' })

    await dm(accountId, person, { text: 'مرحبا' })
    expect((await dmOf(channelId, person))).toMatchObject({ id: nameless!.id, contact_name: 'ahmedshabrawy3' })

    await service.from('conversations').update({ contact_name: 'كريم مصطفى' }).eq('id', nameless!.id)
    await dm(accountId, person, { text: 'تاني' })
    expect((await dmOf(channelId, person))?.contact_name).toBe('كريم مصطفى')
    expect(profileFetches()).toHaveLength(0)
  })
})

describe('a DM after the comment opener', () => {
  it('lands in the conversation the opener opened, which carries the commenter’s username', async () => {
    const { accountId, channelId } = await liveAccount({ comments: true })
    const person = newPerson()
    consoleOutput()
    mockGemini(geminiWorks)
    graph({ recipient: person, username: 'never-used' })

    await comment(accountId, person, 'ahmedshabrawy3', 'بكام التبييض؟')
    const opened = await dmOf(channelId, person)
    expect(opened?.contact_name).toBe('ahmedshabrawy3')

    await dm(accountId, person, { text: 'عايز أعرف السعر' })

    const all = await conversationsOf(channelId, person)
    expect(all.filter((c) => c.thread === 'dm')).toHaveLength(1)
    expect(all.find((c) => c.thread === 'comments')?.contact_name).toBe('ahmedshabrawy3')
    const rows = await rowsOf(opened!.id)
    expect(rows.filter((r) => r.role === 'user').map((r) => r.content)).toEqual(['عايز أعرف السعر'])
    // The opener, then the answer to their DM
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(2)
    expect(profileFetches()).toHaveLength(0)
  })
})

describe('what a DM carries', () => {
  it('typed words with a shared post or a reel go to the pipeline, and what they came with is kept beside them', async () => {
    const { accountId, channelId } = await liveAccount()
    const person = newPerson()
    consoleOutput()
    mockGemini(geminiWorks)
    graph({ username: 'p' })

    await dm(accountId, person, { text: 'العرض ده لسه موجود؟', attachments: [{ type: 'share', payload: { url: 'https://lookaside.example/never-stored' } }] })
    await dm(accountId, person, { text: 'زي ده', attachments: [{ type: 'ig_reel', payload: { reel_video_id: '1' } }] })

    const rows = await rowsOf((await dmOf(channelId, person))!.id)
    expect(rows.filter((r) => r.role === 'user').map((r) => [r.content, r.metadata?.instagram_type]).sort()).toEqual([
      ['العرض ده لسه موجود؟', 'share'],
      ['زي ده', 'ig_reel'],
    ])
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(2)
    expect(JSON.stringify(rows)).not.toContain('lookaside')
  })

  it('a shared post or reel with nothing typed: its placeholder, and the text-only notice once', async () => {
    const { accountId, channelId } = await liveAccount()
    const person = newPerson()
    consoleOutput()
    mockGemini(geminiWorks)
    graph({ username: 'p' })

    await dm(accountId, person, { attachments: [{ type: 'share', payload: { url: 'x' } }] })
    await dm(accountId, person, { attachments: [{ type: 'ig_reel', payload: { reel_video_id: '1' } }] })
    await dm(accountId, person, { attachments: [{ type: 'something_new', payload: {} }] })

    const rows = await rowsOf((await dmOf(channelId, person))!.id)
    expect(rows.filter((r) => r.role === 'user').map((r) => r.content).sort()).toEqual([WHATSAPP_PLACEHOLDER_AR.reel, WHATSAPP_PLACEHOLDER_AR.share, WHATSAPP_PLACEHOLDER_AR.unsupported].sort())
    // Once per run: not again for the second and third in a row
    expect(rows.filter((r) => r.role === 'assistant').map((r) => r.content)).toEqual([WHATSAPP_UNSUPPORTED_AR])
  })

  it('a story mention is left: claimed, not stored, not answered', async () => {
    const { accountId, channelId } = await liveAccount()
    const person = newPerson()
    const output = consoleOutput()
    graph({ username: 'p' })

    await dm(accountId, person, { attachments: [{ type: 'story_mention', payload: { url: 'x' } }] })

    expect(await conversationsOf(channelId, person)).toEqual([])
    expect(graphCalls).toHaveLength(0)
    expect(output()).toContain('story_mention')
  })

})

describe('the account’s echoes, told apart by the ids we recorded', () => {
  const echo = (accountId: string, person: string, mid: string, text: string) =>
    deliver('instagram', { id: accountId, time: 1792569600000, messaging: [{ sender: { id: accountId }, recipient: { id: person }, timestamp: 1792569600000, message: { mid, is_echo: true, text } }] })

  it('the comment opener’s echo is ours: not stored again, not answered, the bot stays on', async () => {
    const { accountId, channelId } = await liveAccount({ comments: true })
    const person = newPerson()
    consoleOutput()
    mockGemini(geminiWorks)
    const openerMid = `m_OPENER_${crypto.randomUUID()}`
    mockGraph((call) => (call.url.endsWith('/replies') ? Response.json({ id: `reply-${crypto.randomUUID()}` }) : Response.json({ recipient_id: person, message_id: openerMid })))

    await comment(accountId, person, 'patient', 'بكام؟')
    const opened = (await dmOf(channelId, person))!
    const before = await rowsOf(opened.id)
    const opener = before.find((r) => r.role === 'assistant')!

    await echo(accountId, person, openerMid, opener.content)

    expect(await rowsOf(opened.id)).toHaveLength(before.length)
    const { data } = await service.from('conversations').select('auto_reply_enabled').eq('id', opened.id).single<{ auto_reply_enabled: boolean }>()
    expect(data!.auto_reply_enabled).toBe(true)
    const { data: claimed } = await service.from('processed_meta_messages').select('message_id').eq('message_id', openerMid)
    expect(claimed).toEqual([{ message_id: openerMid }])
  })

  it('an echo we did not send is a person at the clinic: stored as theirs, and the bot stands down', async () => {
    const { accountId, channelId, clientId } = await liveAccount()
    const person = newPerson()
    consoleOutput()
    graph({ username: 'p' })
    await service.from('conversations').insert({ client_id: clientId, channel_id: channelId, contact_identifier: person, contact_name: 'patient', thread: 'dm', status: 'new' })

    await echo(accountId, person, `m_STAFF_${crypto.randomUUID()}`, 'أهلاً، أنا د. منى من العيادة')

    const conversation = (await dmOf(channelId, person))!
    const rows = await rowsOf(conversation.id)
    expect(rows.map((r) => [r.role, r.content])).toEqual([['agent', 'أهلاً، أنا د. منى من العيادة']])
    expect(rows[0].metadata).toMatchObject({ transport: 'instagram', echo: true })
    const { data } = await service.from('conversations').select('auto_reply_enabled').eq('id', conversation.id).single<{ auto_reply_enabled: boolean }>()
    expect(data!.auto_reply_enabled).toBe(false)
    expect(sends()).toHaveLength(0)
  })
})

describe('Messenger, under the same rule', () => {
  it('an image with typed words: the words reach the pipeline (they used to be dropped)', async () => {
    const seeded = await seedClient()
    const pageId = `PAGE-${crypto.randomUUID()}`
    const { data: channel } = await service.from('channels').insert({ client_id: seeded.clientId, type: 'facebook', name: 'Messenger', external_id: pageId }).select('id').single<{ id: string }>()
    await service.from('channel_secrets').insert({ channel_id: channel!.id, access_token: TOKEN })
    const psid = '7431122334455999'
    consoleOutput()
    mockGemini(geminiWorks)
    mockGraph(() => Response.json({ recipient_id: psid, message_id: `m_OUT_${crypto.randomUUID()}` }))

    await deliver('page', { id: pageId, time: 1792569600000, messaging: [{ sender: { id: psid }, recipient: { id: pageId }, timestamp: 1792569600000, message: { mid: `m_${crypto.randomUUID()}`, text: 'السنة دي بتوجعني', attachments: [{ type: 'image', payload: { url: 'x' } }] } }] })

    const { data: conversation } = await service.from('conversations').select('id').eq('channel_id', channel!.id).eq('contact_identifier', psid).single<{ id: string }>()
    const rows = await rowsOf(conversation!.id)
    expect(rows.filter((r) => r.role === 'user').map((r) => [r.content, r.metadata?.messenger_type])).toEqual([['السنة دي بتوجعني', 'image']])
    expect(rows.filter((r) => r.role === 'assistant')).toHaveLength(1)
    expect(rows.some((r) => r.content === WHATSAPP_UNSUPPORTED_AR)).toBe(false)
  })
})

describe('reply length on Instagram', () => {
  const settings: BotSettingsInput = {
    system_prompt: 'You are the clinic assistant.',
    tone: 'friendly',
    language: 'ar',
    temperature: 0.7,
    max_response_length: 500,
    welcome_message: 'Hello',
    fallback_message: 'Sorry',
    service_unavailable_message: 'Down',
    auto_confirm_appointments: true,
    business_hours: null,
    booking_mode: 'appointment',
    name_strictness: 'single',
  }
  const client = { name: 'Clinic', industry: null, description: null }

  it('the model is asked for at most 400 characters there, and the setting everywhere else', () => {
    expect(buildSystemPrompt(client, settings, [], new Date(), null, false, [], 'instagram')).toContain('under about 400 characters')
    expect(buildSystemPrompt(client, settings, [], new Date(), null, false, [], 'whatsapp')).toContain('under about 500 characters')
    expect(buildSystemPrompt(client, { ...settings, max_response_length: 300 }, [], new Date(), null, false, [], 'instagram')).toContain('under about 300 characters')
  })

  it('a reply past 80% of the bytes is logged with its byte count even when it fits', async () => {
    const { accountId } = await liveAccount()
    const person = newPerson()
    const output = consoleOutput()
    const long = 'م'.repeat(450) // 900 bytes: fits, and past 800
    mockGemini((call) => (call.kind === 'reply' ? botReply(long) : geminiWorks(call)))
    graph({ username: 'p' })

    await dm(accountId, person, { text: 'احكيلي عن العيادة' })

    expect(sends()).toHaveLength(1)
    expect(output()).toContain('near the byte limit')
    expect(output()).toContain('"bytes":900')
  })
})
