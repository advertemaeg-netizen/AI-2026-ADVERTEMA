import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { errorForLog } from '@/lib/log'

/**
 * DISCONNECTING TAKES OUR APP OFF THE ACCOUNT (2026-11-12).
 *
 * Connecting subscribes our app to the channel's own object: the Page
 * (Facebook), the Instagram account, or the WhatsApp Business Account.
 * Until now deleting a channel deleted our row and its token and told Meta
 * nothing: the object stayed subscribed and Meta went on sending us its
 * webhooks, which we dropped. Now, before the row goes:
 *
 *   DELETE /{page-id | ig-account-id | waba-id}/subscribed_apps
 *
 * with the channel's own token, while we still hold it.
 *
 * NOT when another channel row of ours still uses that object: a Page or
 * Instagram account can be held by two clients when one is paused, and one
 * WABA can carry several numbers. Unsubscribing would cut the other off.
 *
 * NEVER BLOCKS THE DELETE (the owner: "a business that clicks disconnect
 * must always be able to disconnect"). A refusal, a timeout or a missing
 * token is logged and the channel is deleted anyway. Every outcome is one
 * line under [meta/unsubscribe] with the channel id, its type, the object id
 * (the Page, Instagram account or WABA: business ids, never a person's) and
 * Meta's status and error code, so a still-subscribed object can be found
 * later: grep the log for "[meta/unsubscribe]" with an outcome other than
 * "unsubscribed" or "kept". Never the token.
 */

/** Page and Instagram were subscribed on v26.0 (connect.ts); the WABA on v25.0 (subscription.ts) */
const GRAPH_PAGE_IG = 'https://graph.facebook.com/v26.0'
const GRAPH_WABA = 'https://graph.facebook.com/v25.0'
const TIMEOUT_MS = 10_000
const LOG = '[meta/unsubscribe]'

export type UnsubscribeOutcome =
  | 'unsubscribed'
  /** Another channel row of ours uses the same object: left subscribed */
  | 'kept'
  /** A website channel: nothing at Meta */
  | 'not_meta'
  /** No token or no object id stored: nothing could be asked */
  | 'not_possible'
  | 'refused'
  | 'request_failed'

type ChannelRow = { id: string; type: string; external_id: string | null }

export async function unsubscribeChannel(admin: SupabaseClient, channel: ChannelRow): Promise<UnsubscribeOutcome> {
  const base = { channelId: channel.id, type: channel.type }
  try {
    if (channel.type !== 'facebook' && channel.type !== 'instagram' && channel.type !== 'whatsapp') return 'not_meta'

    const { data: secret, error } = await admin
      .from('channel_secrets')
      .select('access_token, waba_id')
      .eq('channel_id', channel.id)
      .maybeSingle<{ access_token: string | null; waba_id: string | null }>()
    if (error) throw error
    const objectId = channel.type === 'whatsapp' ? secret?.waba_id ?? null : channel.external_id
    if (!secret?.access_token || !objectId) {
      console.warn(`${LOG} not_possible`, { ...base, objectId, missing: !objectId ? 'object_id' : 'token' })
      return 'not_possible'
    }

    // Another row of ours on the same object keeps it subscribed
    const others =
      channel.type === 'whatsapp'
        ? await admin.from('channel_secrets').select('channel_id', { count: 'exact', head: true }).eq('waba_id', objectId).neq('channel_id', channel.id)
        : await admin.from('channels').select('id', { count: 'exact', head: true }).eq('type', channel.type).eq('external_id', objectId).neq('id', channel.id)
    if (others.error) throw others.error
    if ((others.count ?? 0) > 0) {
      console.info(`${LOG} kept`, { ...base, objectId, otherChannels: others.count })
      return 'kept'
    }

    const graph = channel.type === 'whatsapp' ? GRAPH_WABA : GRAPH_PAGE_IG
    let response: Response
    try {
      response = await fetch(`${graph}/${encodeURIComponent(objectId)}/subscribed_apps`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${secret.access_token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
      })
    } catch (cause) {
      console.error(`${LOG} request_failed`, { ...base, objectId, cause: errorForLog(cause) })
      return 'request_failed'
    }
    const answer = (await response.json().catch(() => ({}))) as { success?: unknown; error?: { code?: unknown; error_subcode?: unknown } }
    if (response.ok && answer.success === true) {
      console.info(`${LOG} unsubscribed`, { ...base, objectId })
      return 'unsubscribed'
    }
    console.error(`${LOG} refused`, {
      ...base,
      objectId,
      status: response.status,
      code: typeof answer.error?.code === 'number' ? answer.error.code : null,
      subcode: typeof answer.error?.error_subcode === 'number' ? answer.error.error_subcode : null,
    })
    return 'refused'
  } catch (error) {
    console.error(`${LOG} request_failed`, { ...base, cause: errorForLog(error) })
    return 'request_failed'
  }
}
