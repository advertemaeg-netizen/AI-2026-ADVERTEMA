import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../app/api/webhook/meta/route'
import { loadForReply, replyAvailability } from '@/lib/agent-reply'
import { flushAfter, geminiCalls, graphCalls, mockGemini, mockGraph, seedClient, serviceClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply } from '../leads/webhook'
import { accountEvent, APP_SECRET, BUSINESS_NUMBER, contactSync, deliver, historyChunk, historyDeclined, historyMedia, PERSON, phoneChange, phoneEcho, whatsappChannel } from './coexistence-payloads'

/**
 * COEXISTENCE, SWITCHED ON (2026-11-15). Unit-tested against Meta's
 * documented payloads (coexistence-payloads.ts); never against Meta itself:
 * that needs the App Review through, the four fields subscribed and a spare
 * number. What holds:
 *   - a message from the business's phone is a person's reply: stored as
 *     sent_from 'phone', it hands the chat to people and the bot never
 *     answers over it (insert_bot_reply);
 *   - an edit or a deletion on the phone is applied to its row;
 *   - history is imported once, marked imported, and NEVER answered: no
 *     model call, no send, no window opened, no hand-off;
 *   - progress 100 is the only completion; a declined history is final;
 *   - contacts name conversations; a device change pauses the number.
 */

const service = serviceClient()

beforeEach(() => {
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
  vi.stubEnv('META_WHATSAPP_COEXISTENCE', 'on')
  for (const level of ['info', 'warn', 'error', 'log'] as const) vi.spyOn(console, level).mockImplementation(() => {})
  mockGemini((call: GeminiCall) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    if (call.kind === 'analysis') return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(analyseTranscript(call)) }] } }] })
    return botReply('أهلاً بيك', null, null)
  })
  mockGraph(() => Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT.${crypto.randomUUID()}` }] }))
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

type Row = { role: string; content: string; sent_from: string | null; imported: boolean; sent_at: string | null; metadata: Record<string, unknown> | null }

async function conversationOf(channelId: string, contact = PERSON) {
  const { data } = await service.from('conversations').select('id, auto_reply_enabled, contact_name, created_at, last_message_at').eq('channel_id', channelId).eq('contact_identifier', contact).maybeSingle()
  return data as { id: string; auto_reply_enabled: boolean; contact_name: string | null; created_at: string; last_message_at: string | null } | null
}

async function rowsOf(conversationId: string) {
  const { data } = await service.from('messages').select('role, content, sent_from, imported, sent_at, metadata').eq('conversation_id', conversationId).order('seq')
  return (data ?? []) as Row[]
}

/** A live message from the person, as Meta delivers it on `messages` */
async function personWrites(phoneNumberId: string, text: string) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [{ id: 'WABA', changes: [{ field: 'messages', value: { messaging_product: 'whatsapp', metadata: { display_phone_number: BUSINESS_NUMBER, phone_number_id: phoneNumberId }, contacts: [{ profile: { name: 'سارة' }, wa_id: PERSON }], messages: [{ from: PERSON, id: `wamid.${crypto.randomUUID()}`, timestamp: '1792569600', type: 'text', text: { body: text } }] } }] }],
  })
  await POST(new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` }, body }))
  await flushAfter()
}

const sends = () => graphCalls.filter((c) => c.method === 'POST' && new URL(c.url).pathname.endsWith('/messages'))
const replies = () => geminiCalls.filter((c) => c.kind === 'reply')

describe('a message from the business’s own phone', () => {
  it('is stored as a person’s reply from the phone, hands the chat to people, and is stored once however often it comes', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)
    await personWrites(phoneNumberId, 'بكام التنظيف؟')
    const conversation = (await conversationOf(channelId))!
    expect(conversation.auto_reply_enabled).toBe(true)

    const echo = phoneEcho(wabaId, phoneNumberId, { id: 'wamid.PHONE.1', text: 'التنظيف بـ 500' })
    await deliver(echo)
    await deliver(echo)

    const rows = await rowsOf(conversation.id)
    expect(rows.filter((r) => r.sent_from === 'phone')).toEqual([
      expect.objectContaining({ role: 'agent', content: 'التنظيف بـ 500', imported: false, metadata: expect.objectContaining({ messageId: 'wamid.PHONE.1', whatsapp_type: 'text' }) }),
    ])
    expect((await conversationOf(channelId))!.auto_reply_enabled).toBe(false)
  })

  it('withholds the bot’s reply to the message it answered from the phone: insert_bot_reply names the phone a person', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)
    await personWrites(phoneNumberId, 'بكام التنظيف؟')
    const conversation = (await conversationOf(channelId))!
    const { data: question } = await service.from('messages').select('id').eq('conversation_id', conversation.id).eq('role', 'user').order('seq', { ascending: false }).limit(1).single<{ id: string }>()
    await deliver(phoneEcho(wabaId, phoneNumberId, { id: 'wamid.PHONE.2', text: 'التنظيف بـ 500' }))

    const { data } = await service.rpc('insert_bot_reply', { p_conversation_id: conversation.id, p_answers: question!.id, p_content: 'the bot', p_metadata: {} })
    expect(data).toEqual([{ id: null, withheld: 'person' }])
  })

  it('applies an edit and a deletion made on the phone to the message they change', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)
    await deliver(phoneEcho(wabaId, phoneNumberId, { id: 'wamid.PHONE.3', text: 'متاح بكرة الساعة 5' }))
    await deliver(phoneChange(wabaId, phoneNumberId, { id: 'wamid.EDIT.3', original: 'wamid.PHONE.3', kind: 'edit', text: 'متاح بكرة الساعة 6' }))
    const conversation = (await conversationOf(channelId))!
    let [row] = (await rowsOf(conversation.id)).filter((r) => r.sent_from === 'phone')
    expect(row.content).toBe('متاح بكرة الساعة 6')
    expect(row.metadata).toHaveProperty('edited_at')

    await deliver(phoneChange(wabaId, phoneNumberId, { id: 'wamid.REVOKE.3', original: 'wamid.PHONE.3', kind: 'revoke' }))
    ;[row] = (await rowsOf(conversation.id)).filter((r) => r.sent_from === 'phone')
    expect(row.metadata).toHaveProperty('revoked_at')
    // The edit and the deletion are changes to one message, not messages of their own
    expect((await rowsOf(conversation.id)).filter((r) => r.sent_from === 'phone')).toHaveLength(1)
  })

  it('is ignored on a channel that is not coexistence', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId, { coexistence: false })
    await deliver(phoneEcho(wabaId, phoneNumberId, { id: 'wamid.PHONE.4' }))
    expect(await conversationOf(channelId)).toBeNull()
  })
})

describe('the one-shot history import', () => {
  it('imports the chunk as history, and nothing about it is ever answered or sent', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)

    await deliver(historyChunk(wabaId, phoneNumberId, { progress: 40 }))
    // The past image's media: value.messages, a live message's own shape, on `history`
    await deliver(historyMedia(wabaId, phoneNumberId, 'wamid.H1'))

    // NO OUTBOUND CALL, NO MODEL CALL: imported history never produces a reply
    expect(sends()).toHaveLength(0)
    expect(graphCalls).toHaveLength(0)
    expect(replies()).toHaveLength(0)

    const conversation = (await conversationOf(channelId))!
    expect(await rowsOf(conversation.id)).toEqual([
      expect.objectContaining({ role: 'user', content: 'عايز أحجز تنظيف', imported: true, sent_from: null }),
      expect.objectContaining({ role: 'agent', content: 'أهلاً، الخميس مناسب؟', imported: true, sent_from: 'phone' }),
    ])
    // Meta's time for it, not the import's
    expect(new Date((await rowsOf(conversation.id))[0].sent_at!).toISOString()).toBe(new Date(1730000000 * 1000).toISOString())
    // The business's past reply does not hand the chat to people, and the chat begins when it began
    expect(conversation.auto_reply_enabled).toBe(true)
    expect(new Date(conversation.created_at).toISOString()).toBe(new Date(1730000000 * 1000).toISOString())
    // The media id onto the imported row, its other metadata kept
    const [first] = await rowsOf(conversation.id)
    expect(first.metadata).toMatchObject({ wamid: 'wamid.H1', media_id: 'MEDIA-77' })
    // No claim for the history media: only `messages` is claimed
    const { count } = await service.from('processed_meta_messages').select('*', { count: 'exact', head: true }).eq('message_id', 'wamid.H1')
    expect(count).toBe(0)

    const { data: channel } = await service.from('channels').select('history_sync, history_sync_progress, history_imported').eq('id', channelId).single()
    expect(channel).toEqual({ history_sync: 'receiving', history_sync_progress: 40, history_imported: 2 })
  })

  it('imports a resent chunk once, completes only at progress 100, and never moves progress back', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)
    await deliver(historyChunk(wabaId, phoneNumberId, { progress: 60 }))
    await deliver(historyChunk(wabaId, phoneNumberId, { progress: 60 }))
    await deliver(historyChunk(wabaId, phoneNumberId, { progress: 30, chunk: 0, messages: [{ id: 'wamid.H0', fromPerson: true, text: 'السلام عليكم', at: 1729000000 }] }))
    let { data: channel } = await service.from('channels').select('history_sync, history_sync_progress, history_imported').eq('id', channelId).single()
    expect(channel).toEqual({ history_sync: 'receiving', history_sync_progress: 60, history_imported: 3 })

    await deliver(historyChunk(wabaId, phoneNumberId, { progress: 100, chunk: 9, messages: [] }))
    ;({ data: channel } = await service.from('channels').select('history_sync, history_sync_progress, history_imported').eq('id', channelId).single())
    expect(channel).toEqual({ history_sync: 'complete', history_sync_progress: 100, history_imported: 3 })
    // The raw chunks are gone once imported
    const { count } = await service.from('whatsapp_history_chunks').select('*', { count: 'exact', head: true }).eq('channel_id', channelId)
    expect(count).toBe(0)
  })

  it('records a declined history as final', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)
    await deliver(historyDeclined(wabaId, phoneNumberId))
    await deliver(historyChunk(wabaId, phoneNumberId, { progress: 100 }))
    const { data } = await service.from('channels').select('history_sync').eq('id', channelId).single()
    expect(data).toEqual({ history_sync: 'declined' })
  })

  it('is left out of everything live: the bot’s history, the reply window, insert_bot_reply', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)
    await deliver(historyChunk(wabaId, phoneNumberId, { progress: 100 }))
    const conversation = (await conversationOf(channelId))!

    // Only imported messages: the person has not written since onboarding, so no window is open
    const loaded = (await loadForReply(service, conversation.id))!
    expect(await replyAvailability(service, loaded)).toEqual({ blocked: 'outside_window', windowEndsAt: null })

    // They write: the bot answers them, reading none of the imported history
    await personWrites(phoneNumberId, 'لسه متاح الخميس؟')
    expect(replies()).toHaveLength(1)
    const prompt = JSON.stringify(replies()[0].body.contents)
    expect(prompt).toContain('لسه متاح الخميس؟')
    expect(prompt).not.toContain('عايز أحجز تنظيف')
    expect(prompt).not.toContain('أهلاً، الخميس مناسب؟')
    expect(sends()).toHaveLength(1)
    expect((await replyAvailability(service, (await loadForReply(service, conversation.id))!)).blocked).toBeNull()
  })
})

describe('contacts, and a device change', () => {
  it('names a conversation from the business’s contacts, and forgets a removed one', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)
    await deliver(historyChunk(wabaId, phoneNumberId, { progress: 100 }))
    await deliver(contactSync(wabaId, phoneNumberId, [{ action: 'add', phone: PERSON, name: 'سارة أحمد' }, { action: 'add', phone: '201009999999', name: 'كريم' }]))
    expect((await conversationOf(channelId))!.contact_name).toBe('سارة أحمد')
    await deliver(contactSync(wabaId, phoneNumberId, [{ action: 'remove', phone: '201009999999' }]))
    const { data: contacts } = await service.from('whatsapp_contacts').select('phone_number, full_name').eq('channel_id', channelId)
    expect(contacts).toEqual([{ phone_number: PERSON, full_name: 'سارة أحمد' }])
    const { data } = await service.from('channels').select('contacts_sync').eq('id', channelId).single()
    expect(data).toEqual({ contacts_sync: 'complete' })
  })

  it('pauses a number Meta offboarded, and resumes it when Meta reconnects it: never disconnects it', async () => {
    const { clientId } = await seedClient()
    const { channelId, phoneNumberId, wabaId } = await whatsappChannel(clientId)
    await deliver(accountEvent(wabaId, 'ACCOUNT_OFFBOARDED'))
    await personWrites(phoneNumberId, 'مرحبا')
    expect(replies()).toHaveLength(0)
    expect(sends()).toHaveLength(0)

    await deliver(accountEvent(wabaId, 'ACCOUNT_RECONNECTED'))
    await personWrites(phoneNumberId, 'مرحبا تاني')
    expect(replies()).toHaveLength(1)
    const { data } = await service.from('channels').select('is_active, coexistence_offboarded_at').eq('id', channelId).single()
    // The channel itself is never switched off or removed: Meta's pause is the only state
    expect(data).toEqual({ is_active: true, coexistence_offboarded_at: null })
    const { count } = await service.from('channel_secrets').select('*', { count: 'exact', head: true }).eq('channel_id', channelId)
    expect(count).toBe(1)
  })
})
