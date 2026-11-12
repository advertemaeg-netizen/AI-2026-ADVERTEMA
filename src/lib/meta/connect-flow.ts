import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { appOrigin } from '@/lib/app-url'
import { INSTAGRAM_FIELDS, PAGE_FIELDS, instagramMessagesBlocked, pageOffered, subscribe, type ConnectOption, type PageGrant } from '@/lib/meta/connect'
import type { ConnectStatus, PickerAvailability } from '@/lib/types/meta-connect'

/**
 * The connect's server-side pieces shared by the start action, the callback
 * and the picker: configuration, the pending row, who already holds an
 * account, and attaching a token to a channel. The pending row and
 * channel_secrets are reached with the service-role client only.
 */

/** A login's life, and a pick's after the return from Meta */
export const CONNECT_TTL_MS = 10 * 60 * 1000

export type MetaConfig = { appId: string; appSecret: string; configId: string }

/** null when anything is unset: the connect is not offered */
export function metaConfig(): MetaConfig | null {
  const appId = process.env.META_APP_ID
  const appSecret = process.env.META_APP_SECRET
  const configId = process.env.META_LOGIN_CONFIG_ID
  if (!appId || !appSecret || !configId) return null
  return { appId, appSecret, configId }
}

/** One redirect URL for every Meta login; it must be byte-identical in the dialog and the exchange */
export async function callbackUrl() {
  return `${await appOrigin()}/api/oauth/meta/callback`
}

export type PendingRow = {
  id: string
  user_id: string
  client_id: string
  channel_id: string | null
  locale: 'ar' | 'en'
  access_token: string | null
  options: ConnectOption[] | null
  expires_at: string
}

export const PENDING_COLUMNS = 'id, user_id, client_id, channel_id, locale, access_token, options, expires_at'

/** Removes every row whose time is up, anyone's: an expired row holds a live token for nobody */
export async function sweepExpired(admin: SupabaseClient) {
  const { error } = await admin.from('meta_connect_pending').delete().lt('expires_at', new Date().toISOString())
  if (error) console.warn('[meta/connect] sweep failed', { code: error.code })
}

export type Occupancy = { availability: PickerAvailability; channelId: string | null }

/**
 * Who holds this account. Any channel of another client, active OR paused,
 * refuses it: the index allows a paused duplicate, the picker does not
 * (taking it would leave the other clinic a channel it can never resume). A
 * channel of this client means the pick refreshes that channel, the live one
 * first.
 */
export async function occupancy(admin: SupabaseClient, clientId: string, type: 'facebook' | 'instagram' | 'whatsapp', externalId: string): Promise<Occupancy> {
  const { data, error } = await admin
    .from('channels')
    .select('id, client_id, is_active, created_at')
    .eq('type', type)
    .eq('external_id', externalId)
    .returns<{ id: string; client_id: string; is_active: boolean; created_at: string }[]>()
  if (error) throw new Error(`occupancy: ${error.code}`)
  if (data.some((row) => row.client_id !== clientId)) return { availability: 'otherClient', channelId: null }
  const own = [...data].sort((a, b) => Number(b.is_active) - Number(a.is_active) || b.created_at.localeCompare(a.created_at))[0]
  return own ? { availability: 'connected', channelId: own.id } : { availability: 'available', channelId: null }
}

export type AttachResult = { subscribed: boolean; messagesBlocked: boolean }

/**
 * Stores the channel's token and subscribes the account: the Page with its
 * Page token, the Instagram account with the system-user token; then, for
 * Instagram, whether messages can be read (step 6).
 */
export async function attachToken({
  admin,
  channelId,
  type,
  externalId,
  token,
  appId,
}: {
  admin: SupabaseClient
  channelId: string
  type: 'facebook' | 'instagram'
  externalId: string
  token: string
  appId: string
}): Promise<AttachResult> {
  const { error } = await admin.from('channel_secrets').upsert({ channel_id: channelId, access_token: token }, { onConflict: 'channel_id' })
  if (error) throw new Error(`channel_secrets: ${error.code}`)
  const fields = type === 'facebook' ? PAGE_FIELDS : INSTAGRAM_FIELDS
  const subscription = await subscribe({ objectId: externalId, token, fields, appId })
  const messagesBlocked = type === 'instagram' ? (await instagramMessagesBlocked({ igId: externalId, token })) === true : false
  console.info('[meta/connect] attached', { channelId, type, subscribed: subscription.kind === 'subscribed', messagesBlocked })
  return { subscribed: subscription.kind === 'subscribed', messagesBlocked }
}

/**
 * The one status for a connect that attached one or two channels. `created`:
 * a new channel was made, and a new channel is always PAUSED, so the clinic
 * is told it is not answering yet.
 */
export function attachedStatus(results: AttachResult[], created: boolean): ConnectStatus {
  if (results.some((r) => !r.subscribed)) return 'subscribeFailed'
  const blocked = results.some((r) => r.messagesBlocked)
  if (created) return blocked ? 'connectedPausedMessagesBlocked' : 'connectedPaused'
  return blocked ? 'connectedMessagesBlocked' : 'reconnected'
}

/**
 * THE CONNECT'S LOG: one line per decision, in the webhook logger's shape (a
 * tag, then one JSON object), so a connect that misbehaved for a real clinic
 * can be read back step by step. What goes in: the step, the outcome and why,
 * counts, and the ids the webhook log already prints (our client, channel and
 * pending ids; Meta's Page and Instagram account ids). Never a token, a code,
 * a state, an app secret, a name or a username.
 */
export function logConnect(fields: Record<string, unknown>) {
  console.info('[oauth/meta]', JSON.stringify(fields))
}

/** What /me/accounts returned, per Page, as the tasks rule reads it: no names, no tokens */
export function accountsSummary(pages: PageGrant[]) {
  return pages.map((page) => ({
    page: page.id,
    tasks: page.tasks === null ? 'absent' : pageOffered(page.tasks) ? 'messaging' : 'no_messaging',
    instagram: page.instagram?.id ?? null,
    pageToken: page.pageToken ? 'present' : 'absent',
    seenIn: page.seenIn,
  }))
}
