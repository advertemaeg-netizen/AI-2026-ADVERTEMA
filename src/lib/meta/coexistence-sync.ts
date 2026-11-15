import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { connectGraph } from '@/lib/meta/connect'
import { SYNC_WINDOW_MS } from '@/lib/meta/coexistence'

/**
 * COEXISTENCE ONBOARDING, THE META SIDE (2026-11-15, behind
 * META_WHATSAPP_COEXISTENCE). Meta's steps for a number kept on the WhatsApp
 * Business app: onboard as usual, but SKIP REGISTRATION ("the number is
 * already registered": no register call, no PIN), subscribe the WABA, then,
 * within 24 hours and ONCE each, request the contacts and then the history:
 *
 *   POST /{phone-number-id}/smb_app_data  sync_type=smb_app_state_sync | history
 *
 * Meta's answer (a request_id) means accepted, not shared: what was shared
 * arrives by webhook (coexistence-webhooks.ts). A second accepted request is
 * impossible (Meta: "You can only perform this step once"), so a request is
 * retried only when it never reached Meta (no answer at all), at most three
 * times, and never once Meta has answered, refusal or not.
 *
 * Logged: Meta's ids, states and error codes. Never the token.
 */

const TRANSPORT_ATTEMPTS = 3
const LOG = '[whatsapp/coexistence]'

export type BizAppNumber = { id: string; onBizApp: boolean; platformType: string | null }

/** Whether a number is on the WhatsApp Business app and the Cloud API both (Meta's check: is_on_biz_app and platform_type CLOUD_API) */
export async function bizAppNumber(phoneNumberId: string, token: string): Promise<BizAppNumber | null> {
  const answer = await connectGraph(phoneNumberId, { token, query: { fields: 'is_on_biz_app,platform_type' } })
  if (!answer.ok) {
    console.warn(`${LOG} number check refused`, { phoneNumberId, status: answer.status, code: answer.code })
    return null
  }
  return {
    id: phoneNumberId,
    onBizApp: answer.body.is_on_biz_app === true,
    platformType: typeof answer.body.platform_type === 'string' ? answer.body.platform_type : null,
  }
}

/** The one number of the WABA that is on both, or why there is not exactly one */
export async function coexistenceNumber(
  candidates: string[],
  token: string
): Promise<{ kind: 'found'; phoneNumberId: string } | { kind: 'none' | 'several' | 'unreadable' }> {
  const checked = await Promise.all(candidates.map((id) => bizAppNumber(id, token)))
  if (checked.some((n) => n === null)) return { kind: 'unreadable' }
  const both = checked.filter((n): n is BizAppNumber => n !== null && n.onBizApp && n.platformType === 'CLOUD_API')
  if (both.length === 1) return { kind: 'found', phoneNumberId: both[0].id }
  return { kind: both.length === 0 ? 'none' : 'several' }
}

export type SyncKind = 'contacts' | 'history'
const SYNC_TYPE: Record<SyncKind, string> = { contacts: 'smb_app_state_sync', history: 'history' }
const COLUMN: Record<SyncKind, 'contacts_sync' | 'history_sync'> = { contacts: 'contacts_sync', history: 'history_sync' }

export type SyncRequest = 'requested' | 'request_failed' | 'window_missed' | 'already'

/**
 * Asks Meta for one of the two one-shot imports and records what came of it
 * on the channel. Claims the request first (not_requested or request_failed
 * to requested), so two calls never both ask: the claim is the "once".
 */
export async function requestSync(
  admin: SupabaseClient,
  channel: { id: string; phoneNumberId: string; onboardedAt: string },
  kind: SyncKind,
  token: string,
  now = Date.now()
): Promise<SyncRequest> {
  const column = COLUMN[kind]
  if (now - new Date(channel.onboardedAt).getTime() > SYNC_WINDOW_MS) {
    await admin.from('channels').update({ [column]: 'window_missed' }).eq('id', channel.id).in(column, ['not_requested', 'request_failed'])
    console.warn(`${LOG} ${kind} window missed`, { channelId: channel.id })
    return 'window_missed'
  }
  const { data: claimed, error } = await admin
    .from('channels')
    .update({ [column]: 'requested' })
    .eq('id', channel.id)
    .in(column, ['not_requested', 'request_failed'])
    .select('id')
  if (error) throw error
  if (!claimed || claimed.length === 0) return 'already'

  for (let attempt = 1; attempt <= TRANSPORT_ATTEMPTS; attempt += 1) {
    const answer = await connectGraph(`${channel.phoneNumberId}/smb_app_data`, { token, form: { messaging_product: 'whatsapp', sync_type: SYNC_TYPE[kind] } })
    if (answer.ok) {
      console.info(`${LOG} ${kind} requested`, { channelId: channel.id, requestId: typeof answer.body.request_id === 'string' ? answer.body.request_id : null })
      return 'requested'
    }
    // Meta answered: whatever it said, asking again could be the second request it forbids
    if (answer.status !== null) {
      await admin.from('channels').update({ [column]: 'request_failed' }).eq('id', channel.id)
      console.error(`${LOG} ${kind} request refused`, { channelId: channel.id, status: answer.status, code: answer.code, attempt })
      return 'request_failed'
    }
    console.warn(`${LOG} ${kind} request did not reach Meta`, { channelId: channel.id, attempt })
  }
  await admin.from('channels').update({ [column]: 'request_failed' }).eq('id', channel.id)
  console.error(`${LOG} ${kind} request failed: Meta never answered`, { channelId: channel.id, attempts: TRANSPORT_ATTEMPTS })
  return 'request_failed'
}
