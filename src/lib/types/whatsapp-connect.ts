/**
 * Where a WhatsApp connect ended, as the channels page shows it. Each maps to
 * one string under `channels`. The WhatsApp-only ones are the copy owner's
 * (`whatsapp.*`, 2026-11-09); the rest are the Page and Instagram connect's
 * strings that name no platform.
 */
export const WHATSAPP_CONNECT_MESSAGES = {
  connectedPaused: 'connect.connectedPaused',
  reconnected: 'connect.reconnected',
  cancelled: 'whatsapp.connect.cancelled',
  takenByOther: 'whatsapp.error.takenByOther',
  missingPermission: 'whatsapp.error.missingPermission',
  /** The number did not register: the channel exists, paused; "try again" re-registers */
  registerFailed: 'whatsapp.error.registerFailed',
  /** Registered, but our app did not subscribe to the WABA: "try again" subscribes only */
  subscribeFailed: 'whatsapp.error.subscribeFailed',
  channelLimit: 'whatsapp.error.channelLimit',
  metaError: 'connect.metaError',
  notConfigured: 'connection.notConfigured.description',
  subscriptionInactive: 'errors.subscriptionInactive',
  forbidden: 'connect.forbidden',
  impersonating: 'errors.impersonating',
  unknown: 'errors.unknown',
} as const

export type WhatsAppConnectStatus = keyof typeof WHATSAPP_CONNECT_MESSAGES

export const WHATSAPP_CONNECT_SUCCESS: readonly WhatsAppConnectStatus[] = ['connectedPaused', 'reconnected']

/** What the popup handed the browser: the code, and the ids Meta's message event reported. Never trusted on the ids */
export type WhatsAppSignup = { code: string; wabaId: string; phoneNumberId: string }

export type WhatsAppConnectResult = { ok: boolean; status: WhatsAppConnectStatus; channelId?: string }

/** The card's state beyond on or paused (channels.connection_notice) */
export const CONNECTION_NOTICES = ['name_pending', 'removed_by_business'] as const
export type ConnectionNotice = (typeof CONNECTION_NOTICES)[number]
