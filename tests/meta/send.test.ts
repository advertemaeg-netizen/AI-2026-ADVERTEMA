import { afterEach, describe, expect, it, vi } from 'vitest'
import { MAX_TEXT_LENGTH, OUTSIDE_WINDOW_CODE, sendWhatsAppText } from '@/lib/meta/send'
import { graphCalls, mockGraph, seedClient, serviceClient } from '../harness/helpers'

/**
 * The WhatsApp send: one function, text only, the token from channel_secrets,
 * the 24-hour error its own case and never retried, everything else tried
 * once more. And nothing of the message in the log: not the body, not the
 * number, not the token.
 */

const TOKEN = 'EAAG-test-token-never-logged'
const RECIPIENT = '201001234567'
const BODY = 'أهلاً، موعدك الخميس 6 المغرب'

afterEach(() => {
  vi.restoreAllMocks()
})

async function channelWithToken() {
  const seeded = await seedClient()
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
  return { service, channelId: channel.id, phoneNumberId, clientId: seeded.clientId }
}

const accepted = (id = 'wamid.OUT.1') => Response.json({ messaging_product: 'whatsapp', messages: [{ id }] })
const refused = (status: number, code: number) =>
  Response.json({ error: { message: `(#${code}) ${BODY}`, code, error_subcode: 1, fbtrace_id: 'x' } }, { status })

/** Everything written to the console during the test, as one string */
function consoleOutput() {
  const spies = (['info', 'warn', 'error', 'log'] as const).map((level) => vi.spyOn(console, level).mockImplementation(() => {}))
  return () => JSON.stringify(spies.flatMap((spy) => spy.mock.calls))
}

describe('sendWhatsAppText', () => {
  it('posts the text to the channel’s number with its token, exactly in WhatsApp’s shape, and returns the outbound wamid', async () => {
    const { service, channelId, phoneNumberId } = await channelWithToken()
    const output = consoleOutput()
    mockGraph(() => accepted('wamid.OUT.42'))

    const result = await sendWhatsAppText({ supabase: service, channelId, to: RECIPIENT, body: `  ${BODY}  ` })

    expect(result).toEqual({ kind: 'sent', messageId: 'wamid.OUT.42' })
    expect(graphCalls).toHaveLength(1)
    expect(graphCalls[0].url).toBe(`https://graph.facebook.com/v25.0/${phoneNumberId}/messages`)
    expect(graphCalls[0].method).toBe('POST')
    expect(graphCalls[0].headers.authorization).toBe(`Bearer ${TOKEN}`)
    expect(graphCalls[0].body).toEqual({ messaging_product: 'whatsapp', to: RECIPIENT, type: 'text', text: { body: BODY } })
    // Logged: the channel and the wamid. Not logged: the body, the number, the token
    const logged = output()
    expect(logged).toContain(channelId)
    expect(logged).toContain('wamid.OUT.42')
    for (const secret of [BODY, RECIPIENT, TOKEN]) expect(logged).not.toContain(secret)
  })

  it('treats the 24-hour window error (131047) as its own case and does not retry it', async () => {
    const { service, channelId } = await channelWithToken()
    const output = consoleOutput()
    mockGraph(() => refused(400, OUTSIDE_WINDOW_CODE))

    const result = await sendWhatsAppText({ supabase: service, channelId, to: RECIPIENT, body: BODY })

    expect(result).toEqual({ kind: 'outside_window', status: 400 })
    expect(graphCalls).toHaveLength(1)
    const logged = output()
    expect(logged).toContain('outside_window')
    for (const secret of [BODY, RECIPIENT, TOKEN]) expect(logged).not.toContain(secret)
  })

  it('tries once more after a refusal that is not the window, and sends if the retry is accepted', async () => {
    const { service, channelId } = await channelWithToken()
    consoleOutput()
    let calls = 0
    mockGraph(() => (++calls === 1 ? refused(500, 131000) : accepted()))

    const result = await sendWhatsAppText({ supabase: service, channelId, to: RECIPIENT, body: BODY })
    expect(result).toEqual({ kind: 'sent', messageId: 'wamid.OUT.1' })
    expect(graphCalls).toHaveLength(2)
  })

  it('gives up after the second refusal, reporting the last status and code without the error text', async () => {
    const { service, channelId } = await channelWithToken()
    const output = consoleOutput()
    mockGraph(() => refused(401, 190))

    const result = await sendWhatsAppText({ supabase: service, channelId, to: RECIPIENT, body: BODY })
    expect(result).toEqual({ kind: 'failed', status: 401, code: 190, attempts: 2 })
    expect(graphCalls).toHaveLength(2)
    // Meta's error message quoted the body: it stays out of the log
    expect(output()).not.toContain(BODY)
  })

  it('tries once more when the request itself fails, and reports a failure with no status when both do', async () => {
    const { service, channelId } = await channelWithToken()
    consoleOutput()
    let calls = 0
    mockGraph(() => {
      calls += 1
      if (calls === 1) throw new TypeError('fetch failed')
      return accepted('wamid.OUT.2')
    })
    expect(await sendWhatsAppText({ supabase: service, channelId, to: RECIPIENT, body: BODY })).toEqual({ kind: 'sent', messageId: 'wamid.OUT.2' })

    graphCalls.length = 0
    mockGraph(() => {
      throw new TypeError('fetch failed')
    })
    expect(await sendWhatsAppText({ supabase: service, channelId, to: RECIPIENT, body: BODY })).toEqual({
      kind: 'failed',
      status: null,
      code: null,
      attempts: 2,
    })
    expect(graphCalls).toHaveLength(2)
  })

  it('attempts nothing for a channel without a token, or without a number to send from', async () => {
    const seeded = await seedClient()
    const service = serviceClient()
    consoleOutput()
    mockGraph(() => accepted())

    // The seeded website channel: no secret row at all
    expect(await sendWhatsAppText({ supabase: service, channelId: seeded.channelId, to: RECIPIENT, body: BODY })).toEqual({
      kind: 'not_configured',
      missing: 'token',
    })
    // A token on a channel with no phone_number_id
    const { data: channel } = await service
      .from('channels')
      .insert({ client_id: seeded.clientId, type: 'whatsapp', name: 'WhatsApp, half set up' })
      .select('id')
      .single<{ id: string }>()
    await service.from('channel_secrets').insert({ channel_id: channel!.id, access_token: TOKEN })
    expect(await sendWhatsAppText({ supabase: service, channelId: channel!.id, to: RECIPIENT, body: BODY })).toEqual({
      kind: 'not_configured',
      missing: 'phone_number_id',
    })
    expect(graphCalls).toHaveLength(0)
  })

  it('attempts nothing for a body that cannot go as plain text: empty, or past WhatsApp’s length', async () => {
    const { service, channelId } = await channelWithToken()
    consoleOutput()
    mockGraph(() => accepted())

    expect(await sendWhatsAppText({ supabase: service, channelId, to: RECIPIENT, body: '  \n ' })).toEqual({ kind: 'unsendable', reason: 'empty' })
    expect(await sendWhatsAppText({ supabase: service, channelId, to: RECIPIENT, body: 'ع'.repeat(MAX_TEXT_LENGTH + 1) })).toEqual({
      kind: 'unsendable',
      reason: 'too_long',
    })
    expect(graphCalls).toHaveLength(0)
  })
})
