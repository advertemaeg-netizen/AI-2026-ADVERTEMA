import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ar from '../../messages/ar.json'
import { POST } from '../../app/api/webhook/meta/route'
import { WHATSAPP_HANDOFF_AR, WHATSAPP_PLACEHOLDER_AR, WHATSAPP_UNAVAILABLE_AR, WHATSAPP_UNSUPPORTED_AR } from '@/lib/meta/whatsapp-notices-ar'
import { failRest, flushAfter, graphCalls, mockGemini, mockGraph, seedClient, serviceClient, type GeminiCall } from '../harness/helpers'
import { analyseTranscript, botReply, openEveryDay } from '../leads/webhook'

/**
 * WHATSAPP IS A TRANSPORT FOR THE PIPELINE WE HAVE. A text message to a live
 * channel opens the sender's conversation, is stored, is answered by the same
 * replyToMessage() the widget uses, and the reply goes out through the send.
 * The sender's number is known before the first word, so a booking never
 * asks for it. Where the website shows a notice of its own, the clinic
 * speaks: the handoff notice once, the unavailable notice never twice in a
 * row, both written to the conversation. Nothing of a message reaches the log.
 */

const APP_SECRET = 'app-secret-for-tests'
const TOKEN = 'EAAG-test-token-never-logged'
const SENDER = '201001234567'
const TEXT = ar.botReplies

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

const accepted = () => Response.json({ messaging_product: 'whatsapp', messages: [{ id: `wamid.OUT.${crypto.randomUUID()}` }] })

async function liveChannel(bookingMode: 'appointment' | 'none' = 'none') {
  const seeded = await seedClient({ bookingMode })
  const service = serviceClient()
  const phoneNumberId = `PN-${crypto.randomUUID()}`
  const { data: channel, error } = await service
    .from('channels')
    .insert({ client_id: seeded.clientId, type: 'whatsapp', name: 'WhatsApp', external_id: phoneNumberId })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: channel.id, access_token: TOKEN })
  if (secretError) throw secretError
  return { ...seeded, service, phoneNumberId, channelId: channel.id }
}

async function deliverText(phoneNumberId: string, text: string, wamid = `wamid.${crypto.randomUUID()}`) {
  return deliverMessage(phoneNumberId, { type: 'text', text: { body: text } }, wamid)
}

/** A voice note, as Meta delivers one: the media id, never the audio */
const voiceNote = { type: 'audio', audio: { id: 'media-1', mime_type: 'audio/ogg; codecs=opus', sha256: 'x', voice: true } }

async function deliverMessage(phoneNumberId: string, message: Record<string, unknown>, wamid = `wamid.${crypto.randomUUID()}`) {
  const body = JSON.stringify({
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: 'Sara Ahmed' }, wa_id: SENDER }],
              messages: [{ from: SENDER, id: wamid, timestamp: '1792569600', ...message }],
            },
          },
        ],
      },
    ],
  })
  const request = new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}` },
    body,
  })
  const response = await POST(request)
  await flushAfter()
  return { response, wamid }
}

function consoleOutput() {
  const spies = (['info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

async function conversationOf(service: ReturnType<typeof serviceClient>, channelId: string) {
  const { data } = await service
    .from('conversations')
    .select('id, contact_identifier, contact_name, client_id')
    .eq('channel_id', channelId)
    .returns<{ id: string; contact_identifier: string; contact_name: string | null; client_id: string }[]>()
  return data ?? []
}

async function messagesOf(service: ReturnType<typeof serviceClient>, conversationId: string) {
  const { data } = await service
    .from('messages')
    .select('role, content, metadata')
    .eq('conversation_id', conversationId)
    .order('created_at', { ascending: true })
    .returns<{ role: string; content: string; metadata: Record<string, unknown> | null }[]>()
  return data ?? []
}

describe('a WhatsApp text to a live channel', () => {
  it('opens the sender’s conversation, stores the message, answers through the pipeline, and sends the reply to the sender', async () => {
    const { service, channelId, phoneNumberId, clientId } = await liveChannel()
    const output = consoleOutput()
    models(() => botReply('أهلاً بيك، تحت أمرك', null, null))
    mockGraph(() => accepted())

    const { response } = await deliverText(phoneNumberId, 'السلام عليكم')
    expect(response.status).toBe(200)

    const [conversation, ...rest] = await conversationOf(service, channelId)
    expect(rest).toEqual([])
    expect(conversation).toMatchObject({ contact_identifier: SENDER, contact_name: 'Sara Ahmed', client_id: clientId })
    expect((await messagesOf(service, conversation.id)).map((m) => [m.role, m.content])).toEqual([
      ['user', 'السلام عليكم'],
      ['assistant', 'أهلاً بيك، تحت أمرك'],
    ])
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].url).toBe(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`)
    expect(graphCalls[0].body).toEqual({ messaging_product: 'whatsapp', to: SENDER, type: 'text', text: { body: 'أهلاً بيك، تحت أمرك' } })
    // Nothing of the message in the log
    const logged = output()
    for (const secret of ['السلام عليكم', 'أهلاً بيك', SENDER, 'Sara', TOKEN]) expect(logged).not.toContain(secret)
    expect(logged).toContain(conversation.id)
  })

  it('answers the same message once: the retry is a duplicate and sends nothing', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())

    const { wamid } = await deliverText(phoneNumberId, 'مرحبا')
    await deliverText(phoneNumberId, 'مرحبا', wamid)

    const [conversation] = await conversationOf(service, channelId)
    expect((await messagesOf(service, conversation.id)).map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(graphCalls).toHaveLength(1)
  })

  // The sender's number arrives with the delivery (the design's §6): it is on record before the first word
  it('books from a name and a time alone: the number is the sender’s, told to the model and written on the lead, never asked for', async () => {
    const { service, channelId, phoneNumberId, supabase, clientId } = await liveChannel('appointment')
    await openEveryDay({ supabase, clientId })
    consoleOutput()
    // The model reports the name and the time; the message carries no number
    models(() => botReply('تمام، حجزتلك {{appointment}}', { day_type: 'weekday', weekday: 'thursday', hour: 6, period: 'evening' }, { name: 'كريم مصطفى', phone: null }))
    mockGraph(() => accepted())

    await deliverText(phoneNumberId, 'أنا كريم مصطفى، عايز أحجز الخميس الساعة 6 المغرب')

    const [conversation] = await conversationOf(service, channelId)
    const reply = (await messagesOf(service, conversation.id)).find((m) => m.role === 'assistant')!.content
    expect(reply).not.toContain(TEXT.contact.phoneAsk)
    expect(reply).not.toContain(TEXT.appointment.missingPhone)
    expect(reply).toContain('الخميس')
    const { data: leads } = await service
      .from('leads')
      .select('name, phone, appointment_at')
      .eq('conversation_id', conversation.id)
      .returns<{ name: string; phone: string; appointment_at: string }[]>()
    expect(leads!.map((lead) => ({ ...lead, appointment_at: new Date(lead.appointment_at).toISOString() }))).toEqual([
      { name: 'كريم مصطفى', phone: `+${SENDER}`, appointment_at: '2026-10-08T15:00:00.000Z' },
    ])
    expect(graphCalls[0].body).toMatchObject({ to: SENDER, text: { body: reply } })
  })
})

describe('where the website shows a notice, the clinic speaks', () => {
  it('handoff: told once, on the first message a person already has, and not on the ones after', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())
    await deliverText(phoneNumberId, 'مرحبا')
    const [conversation] = await conversationOf(service, channelId)
    // A person took the conversation over from the dashboard
    await service.from('conversations').update({ auto_reply_enabled: false }).eq('id', conversation.id)
    graphCalls.length = 0

    await deliverText(phoneNumberId, 'حد موجود؟')
    await deliverText(phoneNumberId, 'هالو؟')
    await deliverText(phoneNumberId, 'لو سمحت')

    const messages = await messagesOf(service, conversation.id)
    const notices = messages.filter((m) => m.content === WHATSAPP_HANDOFF_AR)
    expect(notices).toHaveLength(1)
    expect(notices[0]).toMatchObject({ role: 'assistant', metadata: { notice: 'handoff', transport: 'whatsapp' } })
    expect(messages.filter((m) => m.role === 'user')).toHaveLength(4)
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].body).toMatchObject({ to: SENDER, text: { body: WHATSAPP_HANDOFF_AR } })
  })

  // The defect of 2026-10-26: the rule looked only at the last outbound message, so an agent's reply in between made the notice fire again
  it('handoff: once a person has spoken, the notice has nothing left to say', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())
    await deliverText(phoneNumberId, 'مرحبا')
    const [conversation] = await conversationOf(service, channelId)
    await service.from('conversations').update({ auto_reply_enabled: false }).eq('id', conversation.id)
    graphCalls.length = 0

    await deliverText(phoneNumberId, 'حد موجود؟')
    // The agent replies from the dashboard
    await service.from('messages').insert({ conversation_id: conversation.id, role: 'agent', content: 'أيوه موجود، اتفضل' })
    await deliverText(phoneNumberId, 'عايز أسأل عن الأسعار')
    await deliverText(phoneNumberId, 'وتفتحوا الجمعة؟')

    const messages = await messagesOf(service, conversation.id)
    expect(messages.filter((m) => m.content === WHATSAPP_HANDOFF_AR)).toHaveLength(1)
    expect(graphCalls).toHaveLength(1)
  })

  it('unavailable: our text, not the client’s settings (which failed to load), never twice in a row', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())

    failRest('/rpc/get_bot_settings', 2)
    await deliverText(phoneNumberId, 'مرحبا')
    await deliverText(phoneNumberId, 'مرحبا؟')

    const [conversation] = await conversationOf(service, channelId)
    const messages = await messagesOf(service, conversation.id)
    expect(messages.map((m) => [m.role, m.content])).toEqual([
      ['user', 'مرحبا'],
      ['assistant', WHATSAPP_UNAVAILABLE_AR],
      ['user', 'مرحبا؟'],
    ])
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].body).toMatchObject({ text: { body: WHATSAPP_UNAVAILABLE_AR } })

    // Settings are back: a real reply, after which the notice may be said again if it comes to that
    await deliverText(phoneNumberId, 'فيه حد؟')
    expect((await messagesOf(service, conversation.id)).at(-1)).toMatchObject({ role: 'assistant', content: 'أهلاً بيك' })
  })
})

describe('a message that is not text', () => {
  it('a voice note is stored as what it is and answered once in the bot’s voice; a second in a row is stored and not answered again', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())

    await deliverMessage(phoneNumberId, voiceNote)
    await deliverMessage(phoneNumberId, voiceNote)
    const [conversation] = await conversationOf(service, channelId)
    expect((await messagesOf(service, conversation.id)).map((m) => [m.role, m.content])).toEqual([
      ['user', WHATSAPP_PLACEHOLDER_AR.voice],
      ['assistant', WHATSAPP_UNSUPPORTED_AR],
      ['user', WHATSAPP_PLACEHOLDER_AR.voice],
    ])
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].body).toMatchObject({ to: SENDER, text: { body: WHATSAPP_UNSUPPORTED_AR } })

    // A text in between is answered by the bot; the next voice note is a new run
    await deliverText(phoneNumberId, 'طيب')
    await deliverMessage(phoneNumberId, voiceNote)
    const contents = (await messagesOf(service, conversation.id)).map((m) => m.content)
    expect(contents.filter((c) => c === WHATSAPP_UNSUPPORTED_AR)).toHaveLength(2)
    expect(contents.at(-3)).toBe('أهلاً بيك')
  })

  it('an image and a document are stored by kind; while a person has the conversation nothing is answered, they can look', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())
    await deliverText(phoneNumberId, 'مرحبا')
    const [conversation] = await conversationOf(service, channelId)
    await service.from('conversations').update({ auto_reply_enabled: false }).eq('id', conversation.id)
    graphCalls.length = 0

    await deliverMessage(phoneNumberId, { type: 'image', image: { id: 'media-2', mime_type: 'image/jpeg' } })
    await deliverMessage(phoneNumberId, { type: 'document', document: { id: 'media-3', filename: 'x-ray.pdf' } })
    const contents = (await messagesOf(service, conversation.id)).map((m) => m.content)
    expect(contents.slice(-2)).toEqual([WHATSAPP_PLACEHOLDER_AR.image, WHATSAPP_PLACEHOLDER_AR.file])
    expect(graphCalls).toHaveLength(0)
  })

  it('a video is stored as a video, not a file: something to watch', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())

    await deliverMessage(phoneNumberId, { type: 'video', video: { id: 'media-4', mime_type: 'video/mp4' } })
    const [conversation] = await conversationOf(service, channelId)
    expect((await messagesOf(service, conversation.id)).map((m) => [m.role, m.content])).toEqual([
      ['user', WHATSAPP_PLACEHOLDER_AR.video],
      ['assistant', WHATSAPP_UNSUPPORTED_AR],
    ])
  })

  it('a reaction is stored where an agent sees it and never answered: the model is not called, nothing is sent, no lead is touched', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    let modelCalls = 0
    models(() => {
      modelCalls++
      return botReply('أهلاً بيك', null, null)
    })
    mockGraph(() => accepted())
    await deliverText(phoneNumberId, 'مرحبا')
    const [conversation] = await conversationOf(service, channelId)
    const { data: leadsBefore } = await service.from('leads').select('id, status, updated_at').eq('conversation_id', conversation.id)
    const callsBefore = modelCalls
    graphCalls.length = 0

    await deliverMessage(phoneNumberId, { type: 'reaction', reaction: { message_id: 'wamid.bot-reply', emoji: '👍' } })
    const rows = await messagesOf(service, conversation.id)
    expect(rows.map((m) => m.content).filter((c) => c === WHATSAPP_PLACEHOLDER_AR.reaction)).toHaveLength(1)
    expect(rows.filter((m) => m.role === 'assistant')).toHaveLength(1)
    expect(graphCalls).toHaveLength(0)
    expect(modelCalls).toBe(callsBefore)
    const { data: leadsAfter } = await service.from('leads').select('id, status, updated_at').eq('conversation_id', conversation.id)
    expect(leadsAfter).toEqual(leadsBefore)
  })
})

describe('a reply the customer never received', () => {
  it('is marked on its row, so the dashboard does not show an answer that never arrived', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => Response.json({ error: { message: 'down', code: 131000 } }, { status: 500 }))

    await deliverText(phoneNumberId, 'مرحبا')
    const [conversation] = await conversationOf(service, channelId)
    const reply = (await messagesOf(service, conversation.id)).find((m) => m.role === 'assistant')!
    expect(reply.content).toBe('أهلاً بيك')
    expect(reply.metadata).toMatchObject({ delivery: { transport: 'whatsapp', failed: 'failed', status: 500, code: 131000 } })
    // The pipeline's own trace stays on the row
    expect(reply.metadata).toHaveProperty('model')
  })
})

describe('what is not answered', () => {
  it('a deactivated channel: the message is not stored and nothing is sent, as the website’s 403', async () => {
    const { service, channelId, phoneNumberId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())
    await service.from('channels').update({ is_active: false }).eq('id', channelId)

    await deliverText(phoneNumberId, 'مرحبا')
    expect(await conversationOf(service, channelId)).toEqual([])
    expect(graphCalls).toHaveLength(0)
  })

  it('two channels with the same number: the active one answers, whichever came first', async () => {
    const { service, channelId, phoneNumberId, clientId } = await liveChannel()
    consoleOutput()
    models(() => botReply('أهلاً بيك', null, null))
    mockGraph(() => accepted())
    // A placeholder from before, deactivated, carrying the same number. Channels count against the
    // plan, so the seeded website channel goes first to make room for it
    await service.from('channels').delete().eq('client_id', clientId).eq('type', 'website')
    const { data: old, error: oldError } = await service
      .from('channels')
      .insert({ client_id: clientId, type: 'whatsapp', name: 'placeholder', external_id: phoneNumberId, is_active: false, created_at: '2026-10-02T15:47:02Z' })
      .select('id')
      .single<{ id: string }>()
    if (oldError) throw new Error(`placeholder insert: ${oldError.code} ${oldError.message}`)

    await deliverText(phoneNumberId, 'مرحبا')
    expect(await conversationOf(service, old!.id)).toEqual([])
    expect((await conversationOf(service, channelId)).map((c) => c.contact_identifier)).toEqual([SENDER])
    expect(graphCalls).toHaveLength(1)
  })
})
