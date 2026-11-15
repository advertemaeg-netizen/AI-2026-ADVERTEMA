import { createHmac } from 'node:crypto'
import { NextRequest } from 'next/server'
import { POST } from '../../app/api/webhook/meta/route'
import { flushAfter, serviceClient } from '../harness/helpers'

/**
 * THE FOUR COEXISTENCE WEBHOOK FIELDS, AS META DOCUMENTS THEM (webhook
 * reference pages for smb_message_echoes, smb_app_state_sync, history and
 * account_update, fetched 2026-11-15; copies in the session's scratchpad).
 * Shapes and key names are Meta's; only the ids and words are ours.
 */

export const APP_SECRET = 'app-secret-for-tests'
export const BUSINESS_NUMBER = '15550783881'
export const PERSON = '201001234567'

const envelope = (wabaId: string, field: string, value: Record<string, unknown>) => ({
  object: 'whatsapp_business_account',
  entry: [{ id: wabaId, changes: [{ value, field }] }],
})

const metadata = (phoneNumberId: string) => ({ display_phone_number: BUSINESS_NUMBER, phone_number_id: phoneNumberId })

/** smb_message_echoes: a text the business sent from the WhatsApp Business app */
export function phoneEcho(wabaId: string, phoneNumberId: string, opts: { id: string; text?: string; type?: string; to?: string }) {
  const type = opts.type ?? 'text'
  return envelope(wabaId, 'smb_message_echoes', {
    messaging_product: 'whatsapp',
    metadata: metadata(phoneNumberId),
    contacts: [{ wa_id: opts.to ?? PERSON, user_id: 'US.13491208655302741918' }],
    message_echoes: [
      {
        from: BUSINESS_NUMBER,
        to: opts.to ?? PERSON,
        to_user_id: 'US.13491208655302741918',
        id: opts.id,
        timestamp: '1739321024',
        type,
        ...(type === 'text' ? { text: { body: opts.text ?? 'متاح بكرة الساعة 5' } } : { [type]: { id: 'MEDIA-1', mime_type: 'image/jpeg' } }),
      },
    ],
  })
}

/** smb_message_echoes: an edit or a deletion of an earlier message, made on the phone */
export function phoneChange(wabaId: string, phoneNumberId: string, opts: { id: string; original: string; kind: 'edit' | 'revoke'; text?: string }) {
  return envelope(wabaId, 'smb_message_echoes', {
    messaging_product: 'whatsapp',
    metadata: metadata(phoneNumberId),
    message_echoes: [
      {
        from: BUSINESS_NUMBER,
        to: PERSON,
        id: opts.id,
        timestamp: '1739321100',
        type: opts.kind,
        ...(opts.kind === 'revoke'
          ? { revoke: { original_message_id: opts.original } }
          : { edit: { original_message_id: opts.original, message: { type: 'text', text: { body: opts.text ?? 'متاح بكرة الساعة 6' } } } }),
      },
    ],
  })
}

/** smb_app_state_sync: a contact added (or edited) and one removed */
export function contactSync(wabaId: string, phoneNumberId: string, changes: { action: 'add' | 'remove'; phone: string; name?: string }[]) {
  return envelope(wabaId, 'smb_app_state_sync', {
    messaging_product: 'whatsapp',
    metadata: metadata(phoneNumberId),
    state_sync: changes.map((c) => ({
      type: 'contact',
      contact: { ...(c.name ? { full_name: c.name, first_name: c.name.split(' ')[0] } : {}), phone_number: c.phone },
      action: c.action,
      metadata: { timestamp: '1738346006' },
    })),
  })
}

/** history: one chunk, one thread with the person, their message and the business's reply */
export function historyChunk(
  wabaId: string,
  phoneNumberId: string,
  opts: { progress: number; phase?: number; chunk?: number; messages?: { id: string; fromPerson: boolean; text?: string; type?: string; at: number }[] }
) {
  const messages = opts.messages ?? [
    { id: 'wamid.H1', fromPerson: true, text: 'عايز أحجز تنظيف', at: 1730000000 },
    { id: 'wamid.H2', fromPerson: false, text: 'أهلاً، الخميس مناسب؟', at: 1730000100 },
  ]
  return envelope(wabaId, 'history', {
    messaging_product: 'whatsapp',
    metadata: metadata(phoneNumberId),
    history: [
      {
        metadata: { phase: opts.phase ?? 0, chunk_order: opts.chunk ?? 1, progress: opts.progress },
        threads: [
          {
            id: PERSON,
            context: { wa_id: PERSON },
            messages: messages.map((m) => ({
              from: m.fromPerson ? PERSON : BUSINESS_NUMBER,
              ...(m.fromPerson ? {} : { to: PERSON }),
              id: m.id,
              timestamp: String(m.at),
              type: m.type ?? 'text',
              ...(m.type && m.type !== 'text' ? {} : { text: { body: m.text ?? '' } }),
              history_context: { status: m.fromPerson ? 'READ' : 'DELIVERED' },
            })),
          },
        ],
      },
    ],
  })
}

/** history: the business declined to share it (Meta's error 2593109) */
export function historyDeclined(wabaId: string, phoneNumberId: string) {
  return envelope(wabaId, 'history', {
    messaging_product: 'whatsapp',
    metadata: metadata(phoneNumberId),
    history: [{ errors: [{ code: 2593109, title: 'History sync is turned off by the business from the WhatsApp Business App', message: 'History sync is turned off by the business from the WhatsApp Business App', error_data: { details: 'History sync is turned off by the business from the WhatsApp Business App' } }] }],
  })
}

/** history: a past image's media, sent separately, in the same value.messages shape a live message has */
export function historyMedia(wabaId: string, phoneNumberId: string, messageId: string) {
  return envelope(wabaId, 'history', {
    messaging_product: 'whatsapp',
    metadata: metadata(phoneNumberId),
    messages: [{ from: PERSON, id: messageId, timestamp: '1730000200', type: 'image', image: { caption: 'دي صورة السنة', mime_type: 'image/jpeg', sha256: 'abc', id: 'MEDIA-77' } }],
  })
}

/** account_update: a coexistence number offboarded after a device change, and reconnected */
export function accountEvent(wabaId: string, event: 'ACCOUNT_OFFBOARDED' | 'ACCOUNT_RECONNECTED') {
  return envelope(wabaId, 'account_update', { event })
}

export async function deliver(payload: unknown) {
  const body = JSON.stringify(payload)
  const signature = `sha256=${createHmac('sha256', APP_SECRET).update(body).digest('hex')}`
  const response = await POST(new NextRequest('https://app.mudrik-ai.com/api/webhook/meta', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Hub-Signature-256': signature }, body }))
  await flushAfter()
  return response
}

/** A WhatsApp channel of the client's, live, with its WABA in channel_secrets; coexistence unless said otherwise */
export async function whatsappChannel(clientId: string, opts: { coexistence?: boolean } = {}) {
  const service = serviceClient()
  const phoneNumberId = `PN-${crypto.randomUUID()}`
  const wabaId = `${Date.now()}${Math.floor(Math.random() * 1e6)}`
  const { data, error } = await service
    .from('channels')
    .insert({ client_id: clientId, type: 'whatsapp', name: 'WhatsApp', external_id: phoneNumberId })
    .select('id')
    .single<{ id: string }>()
  if (error) throw error
  const { error: secretError } = await service.from('channel_secrets').insert({ channel_id: data.id, access_token: 'EAAG-coexistence-token', waba_id: wabaId })
  if (secretError) throw secretError
  if (opts.coexistence !== false) {
    const { error: modeError } = await service
      .from('channels')
      .update({ whatsapp_mode: 'coexistence', coexistence_onboarded_at: new Date().toISOString(), history_sync: 'requested', contacts_sync: 'requested' })
      .eq('id', data.id)
    if (modeError) throw modeError
  }
  return { channelId: data.id, phoneNumberId, wabaId }
}
