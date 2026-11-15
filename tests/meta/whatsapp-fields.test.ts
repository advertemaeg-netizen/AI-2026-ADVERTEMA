import { describe, expect, it } from 'vitest'
import { inboundWhatsAppMessages, inboundWhatsAppStatuses } from '@/lib/meta/webhook'

/**
 * ONLY THE `messages` FIELD IS LIVE (2026-11-15). Coexistence's webhook
 * fields reuse the `messages` field's shapes: `history` sends past media as
 * value.messages, exactly like a new message (Meta's history webhook
 * reference). Read from any field, subscribing `history` would answer up to
 * fourteen days of old photos as new. Nothing subscribes to those fields
 * yet; this must hold before anything does.
 */

const PHONE_NUMBER_ID = 'PN-FIELDS-1'

function delivery(field: string) {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'WABA-1',
        changes: [
          {
            field,
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '15550001111', phone_number_id: PHONE_NUMBER_ID },
              contacts: [{ profile: { name: 'Sara' }, wa_id: '201000000001' }],
              messages: [{ from: '201000000001', id: 'wamid.OLD-PHOTO', timestamp: '1780000000', type: 'image', image: { id: 'MEDIA-1' } }],
              statuses: [{ id: 'wamid.SENT-1', status: 'delivered', recipient_id: '201000000001' }],
            },
          },
        ],
      },
    ],
  }
}

describe('the WhatsApp parsers read the messages field alone', () => {
  it('reads a message and a status that arrive on `messages`', () => {
    expect(inboundWhatsAppMessages(delivery('messages')).map((m) => m.messageId)).toEqual(['wamid.OLD-PHOTO'])
    expect(inboundWhatsAppStatuses(delivery('messages')).map((s) => s.messageId)).toEqual(['wamid.SENT-1'])
  })

  it.each(['history', 'smb_message_echoes', 'smb_app_state_sync', 'account_update'])('takes nothing from `%s`, whatever its value carries', (field) => {
    expect(inboundWhatsAppMessages(delivery(field))).toEqual([])
    expect(inboundWhatsAppStatuses(delivery(field))).toEqual([])
  })

  it('takes nothing from a change that names no field', () => {
    const payload = delivery('messages')
    delete (payload.entry[0].changes[0] as { field?: string }).field
    expect(inboundWhatsAppMessages(payload)).toEqual([])
    expect(inboundWhatsAppStatuses(payload)).toEqual([])
  })
})
