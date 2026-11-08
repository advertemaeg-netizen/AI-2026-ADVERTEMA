import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { POST } from '../../app/api/webhook/meta/route'
import { getConversation, retryAgentMessage, sendAgentMessage } from '@/lib/actions/conversations'
import { buildSystemPrompt } from '@/lib/ai/bot'
import { applyWhatsAppStatus, recordSent } from '@/lib/meta/delivery'
import { INSTAGRAM_MAX_TEXT_BYTES, MAX_TEXT_LENGTH, MESSENGER_MAX_TEXT_LENGTH } from '@/lib/meta/send'
import { canManageClient } from '@/lib/auth/permissions'
import type { BotSettingsInput } from '@/lib/types/bot-settings'
import { REPLY_LIMITS } from '@/lib/types/conversations'
import { createUser, flushAfter, graphCalls, mockGraph, seedClient, serviceClient, type TestUser } from '../harness/helpers'

/**
 * A PERSON'S REPLY FROM THE INBOX REACHES THE PATIENT, OR SAYS IT DID NOT
 * (.scratch/agent-reply-decisions.md §2).
 *
 * Until now sendAgentMessage saved the row and nothing left: on WhatsApp,
 * Messenger and Instagram the employee saw their reply and the patient never
 * got it. These hold what replaced that:
 *   - the reply goes out through the channel's transport, and its row
 *     records 'sent' with Meta's id or 'failed' with a reason;
 *   - a failed reply marks the conversation for a person ('send_failed'),
 *     and only a reply that was sent clears the mark;
 *   - the reply box's reasons (paused, disconnected, outside the window, a
 *     comment thread) are checked again at send time;
 *   - "send again" on the failures that might pass, and not on the others;
 *   - a WhatsApp status that reports a failure after Meta accepted the
 *     message marks the row failed, even when it arrives first;
 *   - the Page's echo of a dashboard reply is ours, not a second message;
 *   - the website is unchanged: no send, no state.
 * Order is never read from created_at (the harness's clock is unreliable for
 * that): rows are found by id, role and state.
 */

const APP_SECRET = 'app-secret-for-tests'
const TOKEN = 'EAAG-agent-reply-token-never-logged'
const PERSON = '201001234567'
const HOUR = 60 * 60_000

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
  vi.spyOn(console, 'info').mockImplementation(() => {})
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  session.user = null
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

type Kind = 'whatsapp' | 'facebook' | 'instagram'

/** A live Meta channel with a token, a person's conversation on it, and an org admin signed in */
async function conversationOn(type: Kind, { thread = 'dm', lastWroteHoursAgo = 1 as number | null, secret = true } = {}) {
  const seeded = await seedClient()
  const service = serviceClient()
  const externalId = `${type}-${crypto.randomUUID()}`
  const { data: channel, error } = await service
    .from('channels')
    .insert({ client_id: seeded.clientId, type, name: type, external_id: externalId })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error
  if (secret) {
    const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: channel.id, access_token: TOKEN })
    if (secretError) throw secretError
  }
  const { data: conversation, error: conversationError } = await service
    .from('conversations')
    .insert({ client_id: seeded.clientId, channel_id: channel.id, contact_identifier: PERSON, thread, status: 'new' })
    .select('id')
    .single<{ id: string }>()
  if (conversationError) throw conversationError
  if (lastWroteHoursAgo !== null) {
    const { error: messageError } = await service
      .from('messages')
      .insert({ conversation_id: conversation.id, role: 'user', content: 'السلام عليكم', created_at: new Date(Date.now() - lastWroteHoursAgo * HOUR).toISOString() })
    if (messageError) throw messageError
  }
  session.user = await createUser('org_admin', seeded.organizationId, 'موظف')
  return { ...seeded, service, externalId, channelId: channel.id, conversationId: conversation.id }
}

type ConversationRow = { auto_reply_enabled: boolean; needs_human_since: string | null; needs_human_reason: string | null }
async function conversationState(service: ReturnType<typeof serviceClient>, id: string) {
  const { data } = await service.from('conversations').select('auto_reply_enabled, needs_human_since, needs_human_reason').eq('id', id).single<ConversationRow>()
  return data!
}

async function markNeedsHuman(service: ReturnType<typeof serviceClient>, id: string) {
  const { error } = await service.from('conversations').update({ needs_human_since: new Date().toISOString(), needs_human_reason: 'service_down' }).eq('id', id)
  if (error) throw error
}

async function agentRows(service: ReturnType<typeof serviceClient>, conversationId: string) {
  const { data } = await service.from('messages').select('id, content, metadata').eq('conversation_id', conversationId).eq('role', 'agent')
  return (data ?? []) as { id: string; content: string; metadata: { send?: Record<string, unknown> } | null }[]
}

const whatsappAccepted = (id = `wamid.OUT.${crypto.randomUUID()}`) => Response.json({ messaging_product: 'whatsapp', messages: [{ id }] })
const metaAccepted = (id = `m_OUT_${crypto.randomUUID()}`) => Response.json({ recipient_id: PERSON, message_id: id })
const graphError = (code: number, subcode?: number, status = 400) => Response.json({ error: { code, ...(subcode ? { error_subcode: subcode } : {}) } }, { status })

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

function whatsappStatus(phoneNumberId: string, wamid: string, status: string, codes: number[] = []) {
  return deliver('whatsapp_business_account', {
    id: 'WABA-1',
    changes: [
      {
        field: 'messages',
        value: {
          messaging_product: 'whatsapp',
          metadata: { display_phone_number: '15550000000', phone_number_id: phoneNumberId },
          statuses: [{ id: wamid, status, timestamp: '1792569600', recipient_id: PERSON, ...(codes.length ? { errors: codes.map((code) => ({ code, title: 'never logged' })) } : {}) }],
        },
      },
    ],
  })
}

describe('a reply from the inbox on a Meta channel', () => {
  it('goes out on WhatsApp to the person’s number, records the sent id, hands over, and clears the mark only once sent', async () => {
    const { service, externalId, conversationId } = await conversationOn('whatsapp')
    await markNeedsHuman(service, conversationId)
    mockGraph(() => whatsappAccepted('wamid.OUT.1'))

    const result = await sendAgentMessage(conversationId, 'أهلاً، الموعد متاح بكرة')

    expect(result.ok).toBe(true)
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].url).toBe(`https://graph.facebook.com/v25.0/${externalId}/messages`)
    expect(graphCalls[0].body).toMatchObject({ messaging_product: 'whatsapp', to: PERSON, type: 'text', text: { body: 'أهلاً، الموعد متاح بكرة' } })
    expect(graphCalls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    if (result.ok) expect(result.data.send).toMatchObject({ state: 'sent', messageId: 'wamid.OUT.1', transport: 'whatsapp' })
    const state = await conversationState(service, conversationId)
    expect(state).toMatchObject({ auto_reply_enabled: false, needs_human_since: null, needs_human_reason: null })
  })

  it('goes out on Messenger and on Instagram to the person’s id, each on its own endpoint', async () => {
    for (const [type, version, transport] of [
      ['facebook', 'v25.0', 'messenger'],
      ['instagram', 'v26.0', 'instagram'],
    ] as const) {
      graphCalls.length = 0
      const { externalId, conversationId } = await conversationOn(type)
      mockGraph(() => metaAccepted('m_OUT_1'))
      const result = await sendAgentMessage(conversationId, 'تحت أمرك')
      expect(graphCalls).toHaveLength(1)
      expect(graphCalls[0].url).toBe(`https://graph.facebook.com/${version}/${externalId}/messages`)
      expect(graphCalls[0].body).toMatchObject({ recipient: { id: PERSON }, message: { text: 'تحت أمرك' } })
      if (result.ok) expect(result.data.send).toMatchObject({ state: 'sent', messageId: 'm_OUT_1', transport })
    }
  })

  it('a refused reply is failed on its row, marks the conversation send_failed, still hands over, and "send again" sends the same row', async () => {
    const { service, conversationId } = await conversationOn('facebook')
    mockGraph(() => graphError(2, undefined, 500))

    const result = await sendAgentMessage(conversationId, 'الحجز اتأكد')

    expect(graphCalls).toHaveLength(2) // the one retry inside the send, no more
    expect(result.ok && result.data.send).toMatchObject({ state: 'failed', reason: 'refused' })
    expect(await conversationState(service, conversationId)).toMatchObject({ auto_reply_enabled: false, needs_human_reason: 'send_failed' })
    expect((await conversationState(service, conversationId)).needs_human_since).not.toBeNull()

    mockGraph(() => metaAccepted('m_OUT_2'))
    const again = await retryAgentMessage(result.ok ? result.data.id : '')
    expect(again.ok && again.data.send).toMatchObject({ state: 'sent', messageId: 'm_OUT_2' })
    expect(await agentRows(service, conversationId)).toHaveLength(1)
    expect(await conversationState(service, conversationId)).toMatchObject({ needs_human_since: null, needs_human_reason: null })
  })

  it('a token Meta calls no good (190) is "disconnected", and offers no "send again"', async () => {
    const { conversationId } = await conversationOn('facebook')
    mockGraph(() => graphError(190, undefined, 401))
    const result = await sendAgentMessage(conversationId, 'مرحبا')
    expect(result.ok && result.data.send).toMatchObject({ state: 'failed', reason: 'disconnected' })
    expect(await retryAgentMessage(result.ok ? result.data.id : '')).toEqual({ ok: false, error: 'validation' })
  })

  it('outside the window by our clock: nothing is attempted, the row says why, the box is closed, and there is no "send again"', async () => {
    const { service, conversationId } = await conversationOn('whatsapp', { lastWroteHoursAgo: 25 })
    mockGraph(() => whatsappAccepted())

    const loaded = await getConversation(conversationId)
    expect(loaded?.reply.blocked).toBe('outside_window')

    const result = await sendAgentMessage(conversationId, 'لسه محتاج الموعد؟')
    expect(graphCalls).toHaveLength(0)
    expect(result.ok && result.data.send).toMatchObject({ state: 'failed', reason: 'outside_window' })
    expect((await conversationState(service, conversationId)).needs_human_reason).toBe('send_failed')
    expect(await retryAgentMessage(result.ok ? result.data.id : '')).toEqual({ ok: false, error: 'validation' })
  })

  it('outside the window by Meta’s answer (10/2534022 on Instagram) is outside_window', async () => {
    const { conversationId } = await conversationOn('instagram')
    mockGraph(() => graphError(10, 2534022))
    const result = await sendAgentMessage(conversationId, 'مرحبا')
    expect(graphCalls).toHaveLength(1)
    expect(result.ok && result.data.send).toMatchObject({ state: 'failed', reason: 'outside_window' })
  })

  it('a reaction does not open the window; a conversation the person never wrote in leaves it to Meta', async () => {
    const { service, conversationId } = await conversationOn('whatsapp', { lastWroteHoursAgo: 30 })
    await service.from('messages').insert({ conversation_id: conversationId, role: 'user', content: '[تفاعل]', metadata: { whatsapp_type: 'reaction' }, created_at: new Date(Date.now() - HOUR).toISOString() })
    expect((await getConversation(conversationId))?.reply.blocked).toBe('outside_window')

    const silent = await conversationOn('facebook', { lastWroteHoursAgo: null })
    expect((await getConversation(silent.conversationId))?.reply).toEqual({ blocked: null, windowEndsAt: null })
  })

  it('a paused channel and a channel with no token: nothing is attempted, and each says so', async () => {
    const paused = await conversationOn('whatsapp')
    await paused.service.from('channels').update({ is_active: false }).eq('id', paused.channelId)
    mockGraph(() => whatsappAccepted())
    expect((await getConversation(paused.conversationId))?.reply.blocked).toBe('paused')
    const p = await sendAgentMessage(paused.conversationId, 'مرحبا')
    expect(p.ok && p.data.send).toMatchObject({ state: 'failed', reason: 'paused' })

    const unplugged = await conversationOn('facebook', { secret: false })
    expect((await getConversation(unplugged.conversationId))?.reply.blocked).toBe('disconnected')
    const u = await sendAgentMessage(unplugged.conversationId, 'مرحبا')
    expect(u.ok && u.data.send).toMatchObject({ state: 'failed', reason: 'disconnected' })
    expect(graphCalls).toHaveLength(0)
  })

  it('too long for Instagram counts bytes: 600 Arabic letters fit the box and not the channel', async () => {
    const { conversationId } = await conversationOn('instagram')
    mockGraph(() => metaAccepted())
    const text = 'م'.repeat(600)
    expect(Buffer.byteLength(text)).toBeGreaterThan(INSTAGRAM_MAX_TEXT_BYTES)
    const result = await sendAgentMessage(conversationId, text)
    expect(graphCalls).toHaveLength(0)
    expect(result.ok && result.data.send).toMatchObject({ state: 'failed', reason: 'too_long' })
  })

  it('a public comment thread takes no reply: refused, nothing stored, nothing sent', async () => {
    const { service, conversationId } = await conversationOn('instagram', { thread: 'comments' })
    mockGraph(() => metaAccepted())
    expect((await getConversation(conversationId))?.reply.blocked).toBe('comment_thread')
    expect(await sendAgentMessage(conversationId, 'شكراً')).toEqual({ ok: false, error: 'forbidden' })
    expect(await agentRows(service, conversationId)).toHaveLength(0)
    expect(graphCalls).toHaveLength(0)
  })

  it('a reply stuck mid-send for minutes is offered "send again"; one just written is not', async () => {
    const { service, conversationId } = await conversationOn('facebook')
    const insert = (minutesAgo: number) =>
      service
        .from('messages')
        .insert({ conversation_id: conversationId, role: 'agent', content: 'مرحبا', sender_id: session.user!.id, metadata: { send: { transport: 'messenger', state: 'sending' } }, created_at: new Date(Date.now() - minutesAgo * 60_000).toISOString() })
        .select('id')
        .single<{ id: string }>()
    const fresh = (await insert(0)).data!
    const stuck = (await insert(5)).data!
    mockGraph(() => metaAccepted('m_OUT_9'))
    expect(await retryAgentMessage(fresh.id)).toEqual({ ok: false, error: 'validation' })
    const again = await retryAgentMessage(stuck.id)
    expect(again.ok && again.data.send).toMatchObject({ state: 'sent', messageId: 'm_OUT_9' })
    expect(graphCalls).toHaveLength(1)
  })
})

describe('on the website', () => {
  it('a reply is saved as before: no send, no state, and it clears the mark on insert', async () => {
    const seeded = await seedClient()
    const service = serviceClient()
    const { data: conversation } = await service
      .from('conversations')
      .insert({ client_id: seeded.clientId, channel_id: seeded.channelId, contact_identifier: crypto.randomUUID(), status: 'new' })
      .select('id')
      .single<{ id: string }>()
    await markNeedsHuman(service, conversation!.id)
    session.user = await createUser('org_admin', seeded.organizationId, 'موظف')

    const result = await sendAgentMessage(conversation!.id, 'أهلاً بيك')

    expect(result.ok && result.data.send).toBeNull()
    expect(graphCalls).toHaveLength(0)
    expect(await conversationState(service, conversation!.id)).toMatchObject({ auto_reply_enabled: false, needs_human_since: null })
  })
})

describe('the Page’s echo of a reply sent from the inbox', () => {
  it('is ours: no second message, the bot stays handed over', async () => {
    const { service, externalId, conversationId } = await conversationOn('facebook')
    mockGraph(() => metaAccepted('m_OUT_ECHO'))
    await sendAgentMessage(conversationId, 'الموعد الساعة ٥')

    await deliver('page', {
      id: externalId,
      time: 1792569600000,
      messaging: [{ sender: { id: externalId }, recipient: { id: PERSON }, timestamp: 1792569601000, message: { mid: 'm_OUT_ECHO', is_echo: true, text: 'الموعد الساعة ٥' } }],
    })

    expect(await agentRows(service, conversationId)).toHaveLength(1)
  })
})

describe('WhatsApp statuses', () => {
  it('a failure reported after Meta accepted the message marks the row failed, with the window as its reason', async () => {
    const { service, externalId, conversationId } = await conversationOn('whatsapp')
    mockGraph(() => whatsappAccepted('wamid.OUT.LATE'))
    const result = await sendAgentMessage(conversationId, 'مرحبا')
    expect(result.ok && result.data.send?.state).toBe('sent')

    await whatsappStatus(externalId, 'wamid.OUT.LATE', 'sent')
    expect((await agentRows(service, conversationId))[0].metadata?.send).toMatchObject({ state: 'sent' })

    await whatsappStatus(externalId, 'wamid.OUT.LATE', 'failed', [131047])
    expect((await agentRows(service, conversationId))[0].metadata?.send).toMatchObject({ state: 'failed', reason: 'outside_window', messageId: 'wamid.OUT.LATE' })
    expect((await conversationState(service, conversationId)).needs_human_reason).toBe('send_failed')
  })

  it('a failure that arrives before the send’s answer is held, and applied when the id is recorded', async () => {
    const { service, channelId, conversationId } = await conversationOn('whatsapp')
    const { data: row } = await service
      .from('messages')
      .insert({ conversation_id: conversationId, role: 'assistant', content: 'رد البوت', metadata: { send: { transport: 'whatsapp', state: 'sending' } } })
      .select('id')
      .single<{ id: string }>()

    expect(await applyWhatsAppStatus(service, channelId, { businessId: 'x', messageId: 'wamid.OUT.EARLY', status: 'failed', recipientId: PERSON, errorCodes: [131026] })).toBe('held')
    await recordSent(service, row!.id, 'whatsapp', 'wamid.OUT.EARLY')

    const { data: after } = await service.from('messages').select('metadata').eq('id', row!.id).single<{ metadata: Record<string, Record<string, unknown>> }>()
    expect(after!.metadata.send).toMatchObject({ state: 'failed', reason: 'refused', messageId: 'wamid.OUT.EARLY' })
    // A bot reply keeps the delivery mark the inbox has always read
    expect(after!.metadata.delivery).toMatchObject({ transport: 'whatsapp', failed: 'failed', code: 131026 })
    const { data: held } = await service.from('meta_pending_statuses').select('message_id').eq('message_id', 'wamid.OUT.EARLY')
    expect(held).toEqual([])
  })
})

describe('the reply box’s limits', () => {
  it('are the transports’ own', () => {
    expect(REPLY_LIMITS.instagram).toEqual({ bytes: INSTAGRAM_MAX_TEXT_BYTES })
    expect(REPLY_LIMITS.facebook).toEqual({ chars: MESSENGER_MAX_TEXT_LENGTH })
    expect('chars' in REPLY_LIMITS.whatsapp && REPLY_LIMITS.whatsapp.chars).toBeLessThanOrEqual(MAX_TEXT_LENGTH)
  })
})

describe('the prompt says where the conversation is', () => {
  const client = { name: 'Clinic', industry: null, description: null }
  const settings: BotSettingsInput = {
    system_prompt: 'You are the clinic assistant.',
    tone: 'friendly',
    language: 'ar',
    temperature: 0.7,
    max_response_length: 500,
    welcome_message: 'WELCOME-MARKER-7',
    fallback_message: 'Sorry',
    service_unavailable_message: 'Down',
    auto_confirm_appointments: true,
    business_hours: null,
    booking_mode: 'appointment',
    name_strictness: 'single',
  }

  it('names the widget and its welcome message on the website only', () => {
    const website = buildSystemPrompt(client, settings, [])
    expect(website).toContain('chat widget')
    expect(website).toContain(settings.welcome_message)
    for (const [surface, name] of [
      ['whatsapp', 'WhatsApp'],
      ['messenger', 'Messenger'],
      ['instagram', 'Instagram'],
    ] as const) {
      const prompt = buildSystemPrompt(client, settings, [], new Date(), null, false, [], surface)
      expect(prompt).toContain(name)
      expect(prompt).not.toContain('chat widget')
      expect(prompt).not.toContain('welcome message')
      expect(prompt).not.toContain(settings.welcome_message)
    }
  })
})
