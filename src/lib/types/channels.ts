export const CHANNEL_TYPES = ['website', 'facebook', 'instagram', 'whatsapp'] as const
export type ChannelType = (typeof CHANNEL_TYPES)[number]

// Channel types that can be created today; the rest show as "coming soon"
export const AVAILABLE_CHANNEL_TYPES: readonly ChannelType[] = ['website']

// `credentials` is intentionally left out so secrets never reach the browser
export type Channel = {
  id: string
  client_id: string
  type: ChannelType
  name: string
  webhook_url: string | null
  is_active: boolean
  created_at: string
}

export type ChannelActionError =
  | 'unauthorized'
  | 'forbidden'
  | 'validation'
  | 'comingSoon'
  | 'notFound'
  | 'unknown'

export type ChannelActionResult =
  | { ok: true }
  | { ok: false; error: ChannelActionError; fieldErrors?: { name?: 'nameRequired' | 'nameTooLong' } }
