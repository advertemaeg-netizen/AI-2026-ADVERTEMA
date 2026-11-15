export const CHANNEL_TYPES = ['website', 'facebook', 'instagram', 'whatsapp'] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

// Channel types that can be created today; the rest show as "coming soon"
export const AVAILABLE_CHANNEL_TYPES: readonly ChannelType[] = ['website']

// A channel's token is never here: it lives in channel_secrets, read by the service role alone
export type Channel = {
  id: string
  client_id: string
  type: ChannelType
  name: string
  webhook_url: string | null
  is_active: boolean
  created_at: string
  /** WhatsApp: what the card must say beyond on or paused (display name under review; access removed by the business) */
  connection_notice?: 'name_pending' | 'removed_by_business' | null
  /** Facebook and Instagram: replies to comments, on or off (20261119100000) */
  comment_replies_enabled?: boolean
  /** Who last turned it on or off, and when: stamped by the database. Null when a script did, or never */
  comment_replies_changed_by_name?: string | null
  comment_replies_changed_at?: string | null
  /** WhatsApp: 'coexistence' when the number is on the WhatsApp Business app too (20261123100000) */
  whatsapp_mode?: 'cloud_api' | 'coexistence'
  coexistence_onboarded_at?: string | null
  /** The one-shot imports Meta allows within 24 hours of onboarding: their state, as the card shows it */
  history_sync?: CoexistenceSync | null
  history_sync_progress?: number | null
  history_imported?: number
  contacts_sync?: CoexistenceSync | null
  /** Meta paused the number after a device change (ACCOUNT_OFFBOARDED) */
  coexistence_offboarded_at?: string | null
}

export type CoexistenceSync = 'not_requested' | 'requested' | 'request_failed' | 'receiving' | 'complete' | 'declined' | 'window_missed'

/** The channel types that can reply to comments */
export const COMMENT_CHANNEL_TYPES: readonly ChannelType[] = ['facebook', 'instagram']

export type ChannelActionError =
  | 'impersonating'
  | 'unauthorized'
  | 'forbidden'
  | 'validation'
  | 'comingSoon'
  | 'notFound'
  | 'limitReached'
  | 'subscriptionInactive'
  | 'unknown'

export type ChannelActionResult =
  | { ok: true }
  | { ok: false; error: ChannelActionError; fieldErrors?: { name?: 'nameRequired' | 'nameTooLong' } }
