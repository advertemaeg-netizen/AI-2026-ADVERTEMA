import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../app/api/webhook/meta/route'
import { flushAfter, interceptRest, mockGemini, mockGraph, seedClient, serviceClient, uniqueViolation } from '../harness/helpers'
import { geminiWorks, newVisitorId, sendVisitorMessage } from '../leads/webhook'

/**
 * ONE CONVERSATION PER PERSON, PER CHANNEL, PER THREAD
 * (conversations_one_per_contact, 20261114100000).
 *
 * Every transport reads the sender's conversation and opens one when there
 * is none. Two messages from one person at once could both read "none" and
 * both insert: on Meta's transports every later lookup for that person then
 * failed, and on the website a visitor's two first messages landed in two
 * conversations. The database now refuses the second, and each creator reads
 * back the one that won.
 *
 * The race is made, not hoped for: the creator's own insert is held, the
 * other message's conversation is written for real by the service role, and
 * the creator's insert is answered with the 23505 the index gives. The answer
 * is PostgREST's shape, not the database's own, because in this harness a
 * failed statement over REST drops PostgREST's one connection (pglite#958,
 * tests/harness/helpers.ts) and the caller would see PGRST001. The index
 * itself is asserted inside the database, through test_sqlstate, where the
 * connection never sees the error. Nothing here reads order from created_at.
 */

const APP_SECRET = 'app-secret-for-tests'
const TOKEN = 'EAAG-one-per-contact-token'
const PERSON = '201009998877'

beforeEach(() => {
  vi.stubEnv('META_VERIFY_TOKEN', 'verify-token-for-tests')
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

const service = serviceClient()

async function metaChannel(type: 'whatsapp' | 'instagram') {
  const seeded = await seedClient()
  const externalId = `${type}-${crypto.randomUUID()}`
  const { data: channel, error } = await service.from('channels').insert({ client_id: seeded.clientId, type, name: type, external_id: externalId }).select('id').single<{ id: string }>()
  if (error) throw error
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: channel.id, access_token: TOKEN })
  if (secretError) throw secretError
  return { ...seeded, externalId, metaChannelId: channel.id }
}

/**
 * Holds the next conversation insert, writes the competing one for real,
 * then answers the held insert as the index does. Returns the competitor's id.
 */
function raceTheNextConversationInsert(competitor: Record<string, unknown>) {
  const won: { id?: string } = {}
  interceptRest({ path: '/conversations', method: 'POST' }, async () => {
    const { data, error } = await service.from('conversations').insert(competitor).select('id').single<{ id: string }>()
    if (error) throw error
    won.id = data.id
    return uniqueViolation('conversations_one_per_contact')
  })
  return won
}

const sqlstate = async (statement: string) => {
  const { data, error } = await service.rpc('test_sqlstate', { statement })
  if (error) throw new Error(error.message)
  return data as string | null
}

async function conversations(channelId: string, contact: string) {
  const { data } = await service.from('conversations').select('id, thread').eq('channel_id', channelId).eq('contact_identifier', contact)
  return (data ?? []) as { id: string; thread: string }[]
}

async function userRows(conversationId: string) {
  const { data } = await service.from('messages').select('content').eq('conversation_id', conversationId).eq('role', 'user')
  return (data ?? []).map((m) => m.content as string)
}

async function deliver(object: string, entry: Record<string, unknown>) {
  const body = JSON.stringify({ object, entry: [entry] })
  const request = new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
    body,
  })
  await POST(request)
  await flushAfter()
}

describe('the index', () => {
  it('refuses a second conversation for the same channel, contact and thread, and only that', async () => {
    const { clientId, channelId } = await seedClient()
    const insert = (contact: string | null, thread: string) =>
      `insert into public.conversations (client_id, channel_id, contact_identifier, thread, status) values ('${clientId}', '${channelId}', ${contact === null ? 'null' : `'${contact}'`}, '${thread}', 'new')`
    expect(await sqlstate(insert('same-person', 'dm'))).toBeNull()
    expect(await sqlstate(insert('same-person', 'dm'))).toBe('23505')
    // Another thread for the same person is another conversation (the public side never reads the private one)
    expect(await sqlstate(insert('same-person', 'comments'))).toBeNull()
    // No contact id: no person to have two of
    expect(await sqlstate(insert(null, 'dm'))).toBeNull()
    expect(await sqlstate(insert(null, 'dm'))).toBeNull()
  })
})

describe('two first messages from one person at once', () => {
  it('on WhatsApp: the second joins the conversation the first opened, and the person has one', async () => {
    const { clientId, externalId, metaChannelId } = await metaChannel('whatsapp')
    mockGemini(geminiWorks)
    mockGraph(() => Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT.${crypto.randomUUID()}` }] }))
    const won = raceTheNextConversationInsert({ client_id: clientId, channel_id: metaChannelId, contact_identifier: PERSON, thread: 'dm', status: 'new' })

    await deliver('whatsapp_business_account', {
      id: 'WABA-1',
      changes: [
        {
          field: 'messages',
          value: {
            messaging_product: 'whatsapp',
            metadata: { display_phone_number: '15550000000', phone_number_id: externalId },
            contacts: [{ wa_id: PERSON, profile: { name: 'مريض' } }],
            messages: [{ from: PERSON, id: `wamid.${crypto.randomUUID()}`, timestamp: '1792569600', type: 'text', text: { body: 'عايز أحجز' } }],
          },
        },
      ],
    })

    const rows = await conversations(metaChannelId, PERSON)
    expect(rows).toEqual([{ id: won.id, thread: 'dm' }])
    expect(await userRows(won.id!)).toEqual(['عايز أحجز'])
  })

  it('on an Instagram comment: the second comment joins the comment thread the first opened', async () => {
    const { clientId, externalId, metaChannelId } = await metaChannel('instagram')
    await service.from('clients').update({ comment_replies_enabled: true }).eq('id', clientId)
    const commenter = `IGSID-${crypto.randomUUID()}`
    mockGraph((call) => (call.url.endsWith('/replies') ? Response.json({ id: `reply-${crypto.randomUUID()}` }) : Response.json({ recipient_id: commenter, message_id: `m_${crypto.randomUUID()}` })))
    const won = raceTheNextConversationInsert({ client_id: clientId, channel_id: metaChannelId, contact_identifier: commenter, thread: 'comments', status: 'new', auto_reply_enabled: false })

    await deliver('instagram', {
      id: externalId,
      time: 1792569600,
      changes: [{ field: 'comments', value: { id: `comment-${crypto.randomUUID()}`, text: 'بكام التنظيف؟', from: { id: commenter, username: 'patient' }, media: { id: 'media-1', media_product_type: 'FEED' } } }],
    })

    const threads = (await conversations(metaChannelId, commenter)).filter((c) => c.thread === 'comments')
    expect(threads).toEqual([{ id: won.id, thread: 'comments' }])
    expect(await userRows(won.id!)).toEqual(['بكام التنظيف؟'])
  })

  it('on the website: the second message joins the visitor’s conversation, and the answer hands the widget its id', async () => {
    const { clientId, channelId } = await seedClient()
    mockGemini(geminiWorks)
    const visitorId = newVisitorId()
    const won = raceTheNextConversationInsert({ client_id: clientId, channel_id: channelId, contact_identifier: visitorId, thread: 'dm', status: 'new' })

    const { status, body } = await sendVisitorMessage(channelId, 'السلام عليكم', { visitorId })

    expect(status).toBe(200)
    expect(body.conversationId).toBe(won.id)
    expect(await conversations(channelId, visitorId)).toEqual([{ id: won.id, thread: 'dm' }])
    expect(await userRows(won.id!)).toEqual(['السلام عليكم'])
  })
})
