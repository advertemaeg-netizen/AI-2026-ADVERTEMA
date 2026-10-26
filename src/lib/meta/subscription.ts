import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * SUBSCRIBED_APPS: THE THING THAT COST AN HOUR (.scratch/whatsapp-send-design.md §5).
 *
 * A WhatsApp Business Account must be subscribed to our app before Meta
 * forwards anything. It is not visible in any Meta interface, there is no
 * error anywhere, and every other indicator reads green: the webhook
 * verifies, `messages` shows Subscribed, the number shows Connected.
 * Messages simply never arrive. On 2026-10-26 the WABA was subscribed to
 * Meta's own "WA DevX Webhook Events 1P App" and not to ours, and nothing on
 * any screen said so.
 *
 * So the subscription is a state we read (subscribedApps) and a step we
 * take when connecting a channel (subscribeApp), not a thing someone
 * remembers. A channel whose WABA is not subscribed is not connected,
 * whatever else is green.
 *
 * Credentials come from channel_secrets (service role only): the token, and
 * the WABA id the number belongs to. Our app id is META_APP_ID. Logged: the
 * channel id, the status, the error code, the app ids Meta lists (those are
 * not secrets). Never the token.
 */

const GRAPH = 'https://graph.facebook.com/v25.0'

export type SubscriptionState =
  /** Our app is among the WABA's subscribed apps */
  | { kind: 'subscribed'; appIds: string[] }
  /** It is not; `appIds` says who is (on 2026-10-26: Meta's own test app) */
  | { kind: 'not_subscribed'; appIds: string[] }
  /** Nothing could be asked: the channel has no token or no WABA id, or META_APP_ID is unset */
  | { kind: 'not_configured'; missing: 'token' | 'waba_id' | 'app_id' }
  /** Meta refused or the request failed */
  | { kind: 'failed'; status: number | null; code: number | null }

type Credentials = { token: string; wabaId: string }

async function credentials(
  supabase: SupabaseClient,
  channelId: string
): Promise<Credentials | Extract<SubscriptionState, { kind: 'not_configured' }>> {
  const { data, error } = await supabase
    .from('channel_secrets')
    .select('access_token, waba_id')
    .eq('channel_id', channelId)
    .maybeSingle<{ access_token: string; waba_id: string | null }>()
  if (error) throw error
  if (!data?.access_token) return { kind: 'not_configured', missing: 'token' }
  if (!data.waba_id) return { kind: 'not_configured', missing: 'waba_id' }
  return { token: data.access_token, wabaId: data.waba_id }
}

/** Meta's answer to GET /{waba_id}/subscribed_apps: the apps, each with its WhatsApp data */
type SubscribedAppsAnswer = {
  data?: { id?: string; whatsapp_business_api_data?: { id?: string; name?: string } }[]
  error?: { code?: number }
}

async function graph(path: string, token: string, init: RequestInit = {}) {
  let response: Response
  try {
    response = await fetch(`${GRAPH}/${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${token}`, ...(init.body ? { 'Content-Type': 'application/json' } : {}) },
      signal: AbortSignal.timeout(15_000),
    })
  } catch {
    return { status: null as number | null, code: null as number | null, body: null }
  }
  const body = (await response.json().catch(() => ({}))) as SubscribedAppsAnswer & { success?: boolean }
  const code = typeof body.error?.code === 'number' ? body.error.code : null
  return { status: response.status as number | null, code, body: response.ok ? body : null }
}

/**
 * Whether the channel's WABA is subscribed to our app, by asking Meta. The
 * state to show wherever a WhatsApp channel is set up or inspected.
 */
export async function subscribedApps({
  supabase,
  channelId,
  appId = process.env.META_APP_ID,
}: {
  /** The service-role client: channel_secrets has no policy for anyone else */
  supabase: SupabaseClient
  channelId: string
  /** Our Meta app id; META_APP_ID unless given */
  appId?: string
}): Promise<SubscriptionState> {
  if (!appId) return report(channelId, { kind: 'not_configured', missing: 'app_id' })
  const creds = await credentials(supabase, channelId)
  if ('kind' in creds) return report(channelId, creds)

  const answer = await graph(`${creds.wabaId}/subscribed_apps`, creds.token)
  if (!answer.body) return report(channelId, { kind: 'failed', status: answer.status, code: answer.code })
  const appIds = (answer.body.data ?? []).flatMap((app) => {
    const id = app.whatsapp_business_api_data?.id ?? app.id
    return id ? [id] : []
  })
  const state: SubscriptionState = appIds.includes(appId) ? { kind: 'subscribed', appIds } : { kind: 'not_subscribed', appIds }
  console.info('[whatsapp/subscription]', { channelId, ...state })
  return state
}

/**
 * Subscribes the channel's WABA to our app, then reads the state back: what
 * connecting a WhatsApp channel does, not a manual step.
 */
export async function subscribeApp({
  supabase,
  channelId,
  appId = process.env.META_APP_ID,
}: {
  supabase: SupabaseClient
  channelId: string
  appId?: string
}): Promise<SubscriptionState> {
  if (!appId) return report(channelId, { kind: 'not_configured', missing: 'app_id' })
  const creds = await credentials(supabase, channelId)
  if ('kind' in creds) return report(channelId, creds)

  const answer = await graph(`${creds.wabaId}/subscribed_apps`, creds.token, { method: 'POST', body: '{}' })
  if (!answer.body || answer.body.success !== true) {
    return report(channelId, { kind: 'failed', status: answer.status, code: answer.code })
  }
  console.info('[whatsapp/subscription] subscribe accepted', { channelId, status: answer.status })
  return subscribedApps({ supabase, channelId, appId })
}

function report<T extends Extract<SubscriptionState, { kind: 'not_configured' | 'failed' }>>(channelId: string, state: T): T {
  console.warn(`[whatsapp/subscription] ${state.kind}`, { channelId, ...state })
  return state
}
