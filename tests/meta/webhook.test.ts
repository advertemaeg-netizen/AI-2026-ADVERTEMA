import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import {
  getRedirectUrl,
  isRewrite,
  unstable_doesMiddlewareMatch,
  unstable_getResponseFromNextConfig,
} from 'next/experimental/testing/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config, proxy } from '../../proxy'
import nextConfig from '../../next.config'
import { GET, POST } from '../../app/api/webhook/meta/route'
import { flushAfter, seedClient } from '../harness/helpers'

/**
 * Meta's webhook: receive and log, on the app's host, outside any auth.
 * Meta's verification call is unauthenticated and follows no redirect, so the
 * first block checks the path the way a request actually reaches the route:
 * the matcher runs the proxy, and the proxy must pass it through untouched.
 */

const VERIFY_TOKEN = 'verify-token-for-tests'
const APP_SECRET = 'app-secret-for-tests'
const PATH = '/api/webhook/meta'
const HANDSHAKE = `${PATH}?hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1158201444`

// A visitor's words and number: neither may reach the log
const SECRET_TEXT = 'عايز احجز يوم الخميس'
const SENDER = '201001234567'

beforeEach(() => {
  vi.stubEnv('META_VERIFY_TOKEN', VERIFY_TOKEN)
  vi.stubEnv('META_APP_SECRET', APP_SECRET)
})
afterEach(() => {
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

function proxied(host: string, path: string, method = 'GET') {
  return proxy(new NextRequest(`https://${host}${path}`, { method, headers: { host } }))
}

describe('how the path is delivered', () => {
  it('runs the proxy on it, so what the proxy answers is what Meta gets', () => {
    expect(unstable_doesMiddlewareMatch({ config, url: HANDSHAKE })).toBe(true)
  })

  it.each(['GET', 'POST'])('on the app’s host, the proxy passes a %s through: no rewrite, no redirect, no locale', async (method) => {
    const response = await proxied('app.mudrik-ai.com', HANDSHAKE, method)
    expect(response.headers.get('x-middleware-next')).toBe('1')
    expect(isRewrite(response)).toBe(false)
    expect(getRedirectUrl(response)).toBeNull()
    expect(response.headers.get('location')).toBeNull()
  })

  it('next.config’s redirects leave it alone', async () => {
    const response = await unstable_getResponseFromNextConfig({ url: `https://app.mudrik-ai.com${HANDSHAKE}`, nextConfig })
    expect(getRedirectUrl(response)).toBeNull()
  })

  // Why the callback is not on the apex: there, every /api path is a redirect
  it('on the site’s host it would be a 307 to the app’s host, which Meta’s handshake does not follow', async () => {
    const response = await proxied('mudrik-ai.com', HANDSHAKE)
    expect(response.status).toBe(307)
    expect(getRedirectUrl(response)).toBe(`https://app.mudrik-ai.com${HANDSHAKE}`)
  })

  it('the route answers the handshake that reaches it', async () => {
    const response = GET(new NextRequest(`https://app.mudrik-ai.com${HANDSHAKE}`))
    expect(response.status).toBe(200)
    expect(response.headers.get('content-type')).toBe('text/plain')
    expect(await response.text()).toBe('1158201444')
  })
})

describe('GET: the verification handshake', () => {
  const handshake = (query: string) => GET(new NextRequest(`https://app.mudrik-ai.com${PATH}?${query}`))

  it.each([
    ['a wrong token', `hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1`],
    ['no token', `hub.mode=subscribe&hub.challenge=1`],
    ['another mode', `hub.mode=unsubscribe&hub.verify_token=${VERIFY_TOKEN}&hub.challenge=1`],
    ['no challenge', `hub.mode=subscribe&hub.verify_token=${VERIFY_TOKEN}`],
  ])('refuses %s with a 403', async (_, query) => {
    const response = handshake(query)
    expect(response.status).toBe(403)
    expect(await response.text()).not.toContain('1')
  })

  it('refuses everything while META_VERIFY_TOKEN is unset, an empty token included', () => {
    vi.stubEnv('META_VERIFY_TOKEN', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(handshake('hub.mode=subscribe&hub.verify_token=&hub.challenge=1').status).toBe(403)
    expect(handshake('hub.mode=subscribe&hub.challenge=1').status).toBe(403)
  })
})

function sign(body: string, secret = APP_SECRET) {
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`
}

async function deliver(payload: unknown, signature?: string | null) {
  const body = JSON.stringify(payload)
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const header = signature === undefined ? sign(body) : signature
  if (header !== null) headers['X-Hub-Signature-256'] = header
  const request = new NextRequest(`https://app.mudrik-ai.com${PATH}`, { method: 'POST', headers, body })
  const arrayBuffer = vi.spyOn(request, 'arrayBuffer')
  const response = await POST(request)
  await flushAfter()
  return { response, bodyRead: arrayBuffer.mock.calls.length > 0 }
}

function whatsappMessage(phoneNumberId: string) {
  return {
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
              messages: [{ from: SENDER, id: 'wamid.ABC123', timestamp: '1792569600', type: 'text', text: { body: SECRET_TEXT } }],
            },
          },
        ],
      },
    ],
  }
}

function logged(spy: { mock: { calls: unknown[][] } }) {
  const lines = spy.mock.calls.filter((call) => call[0] === '[webhook/meta]').map((call) => String(call[1]))
  expect(lines).toHaveLength(1)
  return { raw: lines[0], parsed: JSON.parse(lines[0]) }
}

describe('POST: a delivery', () => {
  it.each([
    ['no signature', null],
    ['a malformed signature', 'sha1=abc'],
  ])('refuses %s with a 401 without reading the body', async (_, signature) => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const { response, bodyRead } = await deliver(whatsappMessage('PN-1'), signature)
    expect(response.status).toBe(401)
    expect(bodyRead).toBe(false)
    expect(info).not.toHaveBeenCalled()
  })

  it('refuses a body signed with another secret, and logs nothing of it', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const payload = whatsappMessage('PN-1')
    const { response } = await deliver(payload, sign(JSON.stringify(payload), 'someone-else'))
    expect(response.status).toBe(401)
    expect(info).not.toHaveBeenCalled()
  })

  it('refuses while META_APP_SECRET is unset', async () => {
    vi.stubEnv('META_APP_SECRET', '')
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const { response } = await deliver(whatsappMessage('PN-1'))
    expect(response.status).toBe(503)
  })

  it('answers a signed WhatsApp message 200 with an empty body, and logs its shape and client, never its text or sender', async () => {
    const { supabase, clientId } = await seedClient()
    const phoneNumberId = `PN-${crypto.randomUUID()}`
    const { data: channel } = await supabase
      .from('channels')
      .insert({ client_id: clientId, type: 'whatsapp', name: 'WhatsApp', external_id: phoneNumberId })
      .select('id')
      .single<{ id: string }>()
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    const { response } = await deliver(whatsappMessage(phoneNumberId))
    expect(response.status).toBe(200)
    expect(await response.text()).toBe('')

    const { raw, parsed } = logged(info)
    expect(parsed).toEqual({
      object: 'whatsapp_business_account',
      channel: 'whatsapp',
      entries: [
        {
          entryId: 'WABA-1',
          businessId: phoneNumberId,
          events: [{ kind: 'message', field: 'messages', messageId: 'wamid.ABC123', messageType: 'text', timestamp: '1792569600' }],
        },
      ],
      clients: { [phoneNumberId]: { clientId, channelId: channel!.id } },
    })
    for (const forbidden of [SECRET_TEXT, SENDER, 'Sara', '15550001111']) expect(raw).not.toContain(forbidden)
  })

  it('logs a WhatsApp status by id and state, its error codes without their text, and says when no client has the number', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    await deliver({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'WABA-1',
          changes: [
            {
              field: 'messages',
              value: {
                metadata: { phone_number_id: 'PN-test-number' },
                statuses: [
                  {
                    id: 'wamid.OUT1',
                    status: 'failed',
                    timestamp: '1792569601',
                    recipient_id: SENDER,
                    errors: [{ code: 131047, title: 'Re-engagement message', error_data: { details: SECRET_TEXT } }],
                  },
                ],
              },
            },
          ],
        },
      ],
    })
    const { raw, parsed } = logged(info)
    expect(parsed.entries[0].events).toEqual([
      { kind: 'status', field: 'messages', messageId: 'wamid.OUT1', status: 'failed', timestamp: '1792569601', errorCodes: [131047] },
    ])
    expect(parsed.clients).toEqual({ 'PN-test-number': 'unmapped' })
    for (const forbidden of [SECRET_TEXT, SENDER, 'Re-engagement']) expect(raw).not.toContain(forbidden)
  })

  it('logs a Messenger message and a read by kind, without the sender’s id or the text', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const psid = '7431122334455667'
    await deliver({
      object: 'page',
      entry: [
        {
          id: 'PAGE-1',
          time: 1792569600000,
          messaging: [
            { sender: { id: psid }, recipient: { id: 'PAGE-1' }, timestamp: 1792569600000, message: { mid: 'm_abc', text: SECRET_TEXT } },
            { sender: { id: psid }, recipient: { id: 'PAGE-1' }, timestamp: 1792569600500, read: { watermark: 1792569600000 } },
            {
              sender: { id: psid },
              recipient: { id: 'PAGE-1' },
              timestamp: 1792569601000,
              message: { mid: 'm_img', attachments: [{ type: 'image', payload: { url: 'https://cdn.example/x.jpg' } }] },
            },
          ],
        },
      ],
    })
    const { raw, parsed } = logged(info)
    expect(parsed.channel).toBe('messenger')
    expect(parsed.entries[0]).toEqual({
      entryId: 'PAGE-1',
      businessId: 'PAGE-1',
      time: 1792569600000,
      events: [
        { kind: 'message', messageId: 'm_abc', messageType: 'text', timestamp: 1792569600000 },
        { kind: 'read', timestamp: 1792569600500 },
        { kind: 'message', messageId: 'm_img', messageType: 'image', timestamp: 1792569601000 },
      ],
    })
    expect(parsed.clients).toEqual({ 'PAGE-1': 'unmapped' })
    for (const forbidden of [SECRET_TEXT, psid, 'cdn.example']) expect(raw).not.toContain(forbidden)
  })

  it('answers 200 to a signed body that is not JSON, and logs only its size', async () => {
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const body = `not json ${SENDER}`
    const request = new NextRequest(`https://app.mudrik-ai.com${PATH}`, {
      method: 'POST',
      headers: { 'X-Hub-Signature-256': sign(body) },
      body,
    })
    const response = await POST(request)
    await flushAfter()
    expect(response.status).toBe(200)
    expect(info).not.toHaveBeenCalled()
    expect(JSON.stringify(warn.mock.calls)).not.toContain(SENDER)
  })
})
