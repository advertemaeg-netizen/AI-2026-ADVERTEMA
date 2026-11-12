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
}

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
