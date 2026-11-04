import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../app/api/webhook/meta/route'
import { WHATSAPP_HANDOFF_AR, WHATSAPP_PLACEHOLDER_AR, WHATSAPP_UNSUPPORTED_AR } from '@/lib/meta/whatsapp-notices-ar'
import { flushAfter, graphCalls, mockGemini, mockGraph, seedClient, serviceClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply } from '../leads/webhook'

/**
 * MESSENGER IS A TRANSPORT FOR THE PIPELINE WE HAVE, like WhatsApp. A text to
 * a live Page opens the sender's direct-message conversation, keyed by
 * (channel, PSID, thread 'dm'), is stored, answered by the same pipeline, and
 * the reply goes back as a RESPONSE to the PSID. The notices are WhatsApp's
 * strings.
 *
 * The Page's echoes are told apart by what we sent, never by a field of the
 * echo: an echo carrying a mid we recorded is ours; one arriving before our
 * send's answer is matched to the row still 'sending' with the same text;
 * anything else is a person at the clinic, stored as an agent message, and
 * the bot stands down. These tests do not read order from created_at (the
 * harness's clock is unreliable for that): they compare sets and counts.
 */

const APP_SECRET = 'app-secret-for-tests'
const TOKEN = 'EAAG-page-token-never-logged'
const PSID = '7431122334455667'

beforeEach(() => {
  vi.stubEnv('META_VERIFY_TOKEN', 'verify-token-for-tests')
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
  vi.useFakeTimers({ toFake: ['Date'] })
  // Monday 5 October 2026, 12:00 in Cairo
  vi.setSystemTime(new Date('2026-10-05T09:00:00.000Z'))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function models(reply: (call: GeminiCall) => Response) {
  mockGemini((call) => {
    if (call.kind === 'embedding') return Response.json({ error: { message: 'no embeddings in tests' } }, { status: 503 })
    return call.kind === 'analysis' ? geminiAnalysis(call) : reply(call)
  })
}
const geminiAnalysis = (call: GeminiCall) =>
  Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(analyseTranscript(call)) }] } }], usageMetadata: { promptTokenCount: 1, candidatesTokenCount: 1, totalTokenCount: 2 } })

const accepted = (mid = `m_OUT_${crypto.randomUUID()}`) => Response.json({ recipient_id: PSID, message_id: mid })

async function livePage() {
  const seeded = await seedClient()
  const service = serviceClient()
  const pageId = `PAGE-${crypto.randomUUID()}`
  const { data: channel, error } = await service
    .from('channels')
    .insert({ client_id: seeded.clientId, type: 'facebook', name: 'Messenger', external_id: pageId })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: channel.id, access_token: TOKEN })
  if (secretError) throw secretError
  return { ...seeded, service, pageId, channelId: channel.id }
}

async function deliver(pageId: string, messaging: Record<string, unknown>[]) {
  const body = JSON.stringify({ object: 'page', entry: [{ id: pageId, time: 1792569600000, messaging }] })
  const request = new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
    body,
  })
  const response = await POST(request)
  await flushAfter()
  return response
}

const fromPerson = (pageId: string, message: Record<string, unknown>) => ({ sender: { id: PSID }, recipient: { id: pageId }, timestamp: 1792569600000, message })

async function deliverText(pageId: string, text: string, mid = `m_${crypto.randomUUID()}`) {
  const response = await deliver(pageId, [fromPerson(pageId, { mid, text })])
  return { response, mid }
}

/** The Page sent a message: Meta's echo, with an app_id that must not decide anything */
function deliverEcho(pageId: string, mid: string, text: string) {
  return deliver(pageId, [{ sender: { id: pageId }, recipient: { id: PSID }, timestamp: 1792569601000, message: { mid, is_echo: true, app_id: 1764087628157038, text } }])
}

function consoleOutput() {
  const spies = (['info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

type Row = { role: string; content: string; metadata: Record<string, unknown> | null }

async function conversationsOf(service: ReturnType<typeof serviceClient>, channelId: string) {
  const { data } = await service
    .from('conversations')
    .select('id, contact_identifier, contact_name, thread, auto_reply_enabled')
    .eq('channel_id', channelId)
    .returns<{ id: string; contact_identifier: string; contact_name: string | null; thread: string; auto_reply_enabled: boolean }[]>()
  return data ?? []
}

async function rowsOf(service: ReturnType<typeof serviceClient>, conversationId: string) {
  const { data } = await service.from('messages').select('role, content, metadata').eq('conversation_id', conversationId).returns<Row[]>()
  return data ?? []
}

const pairs = (rows: Row[]) => rows.map((m) => [m.role, m.content]).sort()

describe('a Messenger text to a live Page', () => {
  it('opens the sender’s direct-message conversation, answers through the pipeline, and sends the reply as a RESPONSE to the PSID', async () => {
    const { service, channelId, pageId } = await livePage()
    const output = consoleOutput()
    models(() => botReply('أهلاً بيك، تحت أمرك', null, null))
    mockGraph(() => accepted('m_OUT_1'))

    const { response } = await deliverText(pageId, 'السلام عليكم')
    expect(response.status).toBe(200)

    const [conversation, ...rest] = await conversationsOf(service, channelId)
    expect(rest).toEqual([])
    // Keyed by the PSID, in the direct-message thread; Messenger gives no name
    expect(conversation).toMatchObject({ contact_identifier: PSID, contact_name: null, thread: 'dm', auto_reply_enabled: true })
    const rows = await rowsOf(service, conversation.id)
    expect(pairs(rows)).toEqual([
      ['assistant', 'أهلاً بيك، تحت أمرك'],
      ['user', 'السلام عليكم'],
    ])
    // The reply row records its send, with the mid Meta answered: how its echo will be known
    expect(rows.find((m) => m.role === 'assistant')!.metadata).toMatchObject({ send: { transport: 'messenger', state: 'sent', messageId: 'm_OUT_1' } })

    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].url).toBe(`https://graph.facebook.com/v25.0/${pageId}/messages`)
    expect(graphCalls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(graphCalls[0].body).toEqual({ recipient: { id: PSID }, messaging_type: 'RESPONSE', message: { text: 'أهلاً بيك، تحت أمرك' } })
    // The token goes in the header, never the URL
    expect(graphCalls[0].url).not.toContain(TOKEN)

    const logged = output()
    for (const secret of ['السلام عليكم', 'أهلاً بيك', PSID, TOKEN]) expect(logged).not.toContain(secret)
    expect(logged).toContain(conversation.id)
  })

  it('answers the same message once: the retry is a duplicate and sends nothing', async () => {
    const { service, channelId, pageId } = await livePage()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())

    const { mid } = await deliverText(pageId, 'مرحبا')
    await deliverText(pageId, 'مرحبا', mid)

    const [conversation] = await conversationsOf(service, channelId)
    expect((await rowsOf(service, conversation.id)).map((m) => m.role).sort()).toEqual(['assistant', 'user'])
    expect(graphCalls).toHaveLength(1)
  })

  it('a comment thread with the same person is a different conversation: the message opens its own, in the dm thread', async () => {
    const { service, channelId, pageId, clientId } = await livePage()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())
    // On Facebook a commenter's id is their PSID: the same contact, another thread
    const { data: comments } = await service
      .from('conversations')
      .insert({ client_id: clientId, channel_id: channelId, contact_identifier: PSID, thread: 'comments', status: 'new' })
      .select('id')
      .single<{ id: string }>()

    await deliverText(pageId, 'مرحبا')

    const conversations = await conversationsOf(service, channelId)
    expect(conversations.map((c) => c.thread).sort()).toEqual(['comments', 'dm'])
    // Nothing of the private message reached the comment thread
    expect(await rowsOf(service, comments!.id)).toEqual([])
  })

  it('outside the 24-hour window (error 10, subcode 2018278): not retried, and the reply is marked as never received', async () => {
    const { service, channelId, pageId } = await livePage()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => Response.json({ error: { message: '(#10) This message is sent outside of allowed window.', code: 10, error_subcode: 2018278 } }, { status: 400 }))

    await deliverText(pageId, 'مرحبا')

    expect(graphCalls).toHaveLength(1)
    const [conversation] = await conversationsOf(service, channelId)
    const reply = (await rowsOf(service, conversation.id)).find((m) => m.role === 'assistant')!
    expect(reply.metadata).toMatchObject({ delivery: { transport: 'messenger', failed: 'outside_window', status: 400 }, send: { state: 'failed' } })
  })
})

describe('the Page’s echoes: ours, or a person at the clinic', () => {
  it('the echo of our reply, after its send was recorded: known by its mid, nothing stored, the bot stays on', async () => {
    const { service, channelId, pageId } = await livePage()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted('m_OUT_7'))
    await deliverText(pageId, 'مرحبا')

    await deliverEcho(pageId, 'm_OUT_7', 'أهلاً بيك')

    const [conversation] = await conversationsOf(service, channelId)
    expect(conversation.auto_reply_enabled).toBe(true)
    expect((await rowsOf(service, conversation.id)).map((m) => m.role).sort()).toEqual(['assistant', 'user'])
  })

  it('the echo arriving before our send’s answer: matched to the row still sending with the same text, which takes the mid', async () => {
    const { service, channelId, pageId } = await livePage()
    const output = consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    // Meta delivers the echo while our send is still waiting for its answer
    mockGraph(async () => {
      await deliverEcho(pageId, 'm_OUT_RACE', 'أهلاً بيك')
      return accepted('m_OUT_RACE')
    })

    await deliverText(pageId, 'مرحبا')

    // The echo was handled, and handled while the row was still sending: the mid came from the echo, not the send's answer
    expect(output()).toContain('echo of ours, before its send was recorded')

    const [conversation] = await conversationsOf(service, channelId)
    // Not filed as a person's message: the bot did not silence itself
    expect(conversation.auto_reply_enabled).toBe(true)
    const rows = await rowsOf(service, conversation.id)
    expect(rows.map((m) => m.role).sort()).toEqual(['assistant', 'user'])
    expect(rows.find((m) => m.role === 'assistant')!.metadata).toMatchObject({ send: { state: 'sent', messageId: 'm_OUT_RACE' } })
  })

  it('a person typing in the inbox while our reply is on its way is a person: stored as theirs, not swallowed as ours', async () => {
    const { service, channelId, pageId } = await livePage()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(async () => {
      await deliverEcho(pageId, 'm_STAFF_1', 'أنا دكتورة سارة، معاك')
      return accepted('m_OUT_8')
    })

    await deliverText(pageId, 'مرحبا')

    const [conversation] = await conversationsOf(service, channelId)
    const rows = await rowsOf(service, conversation.id)
    expect(pairs(rows)).toEqual([
      ['agent', 'أنا دكتورة سارة، معاك'],
      ['assistant', 'أهلاً بيك'],
      ['user', 'مرحبا'],
    ])
    // Our own reply still got its mid
    expect(rows.find((m) => m.role === 'assistant')!.metadata).toMatchObject({ send: { state: 'sent', messageId: 'm_OUT_8' } })
  })

  it('a person answering from the Page inbox: stored as an agent message, the bot stands down, and is told nothing on the next message', async () => {
    const { service, channelId, pageId } = await livePage()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())
    await deliverText(pageId, 'مرحبا')
    graphCalls.length = 0

    await deliverEcho(pageId, 'm_STAFF_2', 'أهلاً، أنا من الفريق')
    // Retried by Meta: stored once
    await deliverEcho(pageId, 'm_STAFF_2', 'أهلاً، أنا من الفريق')

    const [conversation] = await conversationsOf(service, channelId)
    expect(conversation.auto_reply_enabled).toBe(false)
    const agentRows = (await rowsOf(service, conversation.id)).filter((m) => m.role === 'agent')
    expect(agentRows).toHaveLength(1)
    expect(agentRows[0].metadata).toMatchObject({ transport: 'messenger', echo: true, messageId: 'm_STAFF_2' })

    // The person writes again: a person has spoken, so no bot reply and no handoff notice
    await deliverText(pageId, 'تمام، شكراً')
    expect(graphCalls).toHaveLength(0)
    expect((await rowsOf(service, conversation.id)).some((m) => m.content === WHATSAPP_HANDOFF_AR)).toBe(false)
  })

  it('the clinic writing first, to someone with no conversation yet: opens one, handed to people from the start', async () => {
    const { service, channelId, pageId } = await livePage()
    consoleOutput()

    await deliverEcho(pageId, 'm_STAFF_3', 'إزيك، كنا بنتابع معاك')

    const [conversation, ...rest] = await conversationsOf(service, channelId)
    expect(rest).toEqual([])
    expect(conversation).toMatchObject({ contact_identifier: PSID, thread: 'dm', auto_reply_enabled: false })
  })
})

describe('what is not text', () => {
  it('an image is stored as an image and answered once with the WhatsApp text-only reply, sent through Messenger', async () => {
    const { service, channelId, pageId } = await livePage()
    consoleOutput()
    models(() => botReply('لن يُستدعى', null, null))
    mockGraph(() => accepted())

    await deliver(pageId, [fromPerson(pageId, { mid: 'm_IMG_1', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/x.jpg' } }] })])

    const [conversation] = await conversationsOf(service, channelId)
    const rows = await rowsOf(service, conversation.id)
    expect(pairs(rows)).toEqual([
      ['assistant', WHATSAPP_UNSUPPORTED_AR],
      ['user', WHATSAPP_PLACEHOLDER_AR.image],
    ])
    expect(rows.find((m) => m.role === 'user')!.metadata).toEqual({ messenger_type: 'image' })
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].body).toMatchObject({ recipient: { id: PSID }, message: { text: WHATSAPP_UNSUPPORTED_AR } })
  })

  it('a reaction is stored where an agent sees it, once however often Meta sends it, and never answered', async () => {
    const { service, channelId, pageId } = await livePage()
    consoleOutput()
    mockGraph(() => accepted())
    const reaction = { sender: { id: PSID }, recipient: { id: pageId }, timestamp: 1792569602000, reaction: { mid: 'm_OUT_9', action: 'react', emoji: '👍', reaction: 'like' } }

    await deliver(pageId, [reaction])
    await deliver(pageId, [reaction])

    const [conversation] = await conversationsOf(service, channelId)
    const rows = await rowsOf(service, conversation.id)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ role: 'user', content: WHATSAPP_PLACEHOLDER_AR.reaction, metadata: { messenger_type: 'reaction', reaction: { emoji: '👍', action: 'react', messageId: 'm_OUT_9' } } })
    expect(graphCalls).toHaveLength(0)
  })
})

describe('what is not answered', () => {
  it('a Page with no channel of ours: nothing stored, nothing sent', async () => {
    consoleOutput()
    mockGraph(() => accepted())
    await deliverText(`PAGE-${crypto.randomUUID()}`, 'مرحبا')
    expect(graphCalls).toHaveLength(0)
  })

  it('a deactivated channel: the message is not stored and nothing is sent', async () => {
    const { service, channelId, pageId } = await livePage()
    consoleOutput()
    mockGraph(() => accepted())
    await service.from('channels').update({ is_active: false }).eq('id', channelId)

    await deliverText(pageId, 'مرحبا')

    expect(await conversationsOf(service, channelId)).toEqual([])
    expect(graphCalls).toHaveLength(0)
  })
})
