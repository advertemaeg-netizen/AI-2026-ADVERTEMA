import type { NextRequest } from 'next/server'
import { appOrigin } from '@/lib/app-url'
import { canManage, getSession } from '@/lib/auth/session'
import { checkToken, connectOptions, exchangeCode, pageOffered, readGrant, verifyAccess } from '@/lib/meta/connect'
import {
  CONNECT_TTL_MS,
  PENDING_COLUMNS,
  accountsSummary,
  attachToken,
  attachedStatus,
  callbackUrl,
  logConnect,
  metaConfig,
  type PendingRow,
} from '@/lib/meta/connect-flow'
import { createAdminClient } from '@/lib/supabase/admin'
import { routing } from '@/i18n/routing'
import type { ConnectStatus } from '@/lib/types/meta-connect'

/**
 * THE META LOGIN'S RETURN (.scratch/messenger-instagram-design.md §12).
 *
 *   1. Meta sends back code + state, or an error (the clinic cancelled).
 *   2. state: single use (set to null as it is read), within its 10 minutes,
 *      and the session must be the user who started it, still allowed to
 *      manage that client's channels. A token never lands on a client the
 *      login was not started for.
 *   3. The code is exchanged server to server, same redirect_uri.
 *   4. The token: valid, ours, a system user's, every permission granted.
 *      Then the Pages the grant reaches (readGrant: assigned_pages, with
 *      /me/accounts as a second witness, every page of both).
 *   5–6. A reconnect refreshes its own channel here, if its account is among
 *      them, and subscribes it again; it never moves to another account. A
 *      new connect keeps the token server-side and sends the clinic to the
 *      picker, which does the rest.
 *   8. Every redirect carries a status and nothing else.
 *
 * Every exit writes one [oauth/meta] line (logConnect): whether the state was
 * accepted and why not, the session check, Meta's error words, each step, how
 * many Pages /me/accounts returned and how the tasks rule read each, what the
 * picker was given, the outcome. Never logged: the code, the state, the token.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const origin = await appOrigin()
  const admin = createAdminClient()
  const fallback = `/${routing.defaultLocale}/dashboard/clients`
  /** What the log line will say: filled in as the steps pass */
  const trace: Record<string, unknown> = { step: 'callback' }

  const state = params.get('state')
  if (!state) {
    logConnect({ ...trace, state: 'missing', metaError: params.get('error') ?? undefined, outcome: 'expired' })
    return redirectTo(origin, fallback, 'expired')
  }

  // Single use: whoever reads it first takes it, a replay finds nothing
  const { data: pending, error: claimError } = await admin
    .from('meta_connect_pending')
    .update({ state: null })
    .eq('state', state)
    .gt('expires_at', new Date().toISOString())
    .select(PENDING_COLUMNS)
    .maybeSingle<PendingRow>()
  if (!pending) {
    // Why: a row that still holds this state is one whose time ran out; none means unknown, or already used
    const { data: stale } = claimError ? { data: null } : await admin.from('meta_connect_pending').select('id, client_id').eq('state', state).maybeSingle<{ id: string; client_id: string }>()
    logConnect({
      ...trace,
      state: claimError ? 'claim_failed' : stale ? 'expired' : 'unknown_or_used',
      ...(claimError ? { dbCode: claimError.code } : {}),
      ...(stale ? { pendingId: stale.id, clientId: stale.client_id } : {}),
      outcome: 'expired',
    })
    return redirectTo(origin, fallback, 'expired')
  }
  Object.assign(trace, { state: 'accepted', pendingId: pending.id, clientId: pending.client_id, flow: pending.channel_id ? 'reconnect' : 'connect', channelId: pending.channel_id ?? undefined })

  const channelsPath = `/${pending.locale}/dashboard/clients/${pending.client_id}/channels`
  const finish = async (status: ConnectStatus, why: Record<string, unknown> = {}) => {
    const { error } = await admin.from('meta_connect_pending').delete().eq('id', pending.id)
    logConnect({ ...trace, ...why, outcome: status, ...(error ? { pendingDeleteFailed: error.code } : {}) })
    return redirectTo(origin, channelsPath, status)
  }

  const { supabase, profile, impersonation } = await getSession()
  if (!profile) return finish('forbidden', { session: 'none' })
  if (impersonation) return finish('forbidden', { session: 'impersonating' })
  if (profile.id !== pending.user_id) return finish('forbidden', { session: 'other_user' })
  if (!canManage(profile)) return finish('forbidden', { session: 'cannot_manage' })
  const { data: client } = await supabase.from('clients').select('id').eq('id', pending.client_id).maybeSingle<{ id: string }>()
  if (!client) return finish('forbidden', { session: 'client_not_visible' })
  trace.session = 'ok'

  // Meta's own words for a cancel or a refusal: error codes, not secrets
  const metaError = params.get('error') ?? params.get('error_reason')
  if (metaError) return finish('cancelled', { metaError: params.get('error'), metaErrorReason: params.get('error_reason') })
  const code = params.get('code')
  if (!code) return finish('cancelled', { code: 'missing' })

  const config = metaConfig()
  if (!config) return finish('notConfigured')

  const token = await exchangeCode({ code, redirectUri: await callbackUrl(), appId: config.appId, appSecret: config.appSecret })
  if (!token) return finish('metaError', { exchange: 'failed' })
  trace.exchange = 'ok'

  const check = await checkToken({ token, appId: config.appId, appSecret: config.appSecret })
  if (check.kind === 'missingPermission') return finish('missingPermission', { token: 'missing_permission', missing: check.missing })
  if (check.kind !== 'ok') return finish('metaError', { token: check.kind })
  trace.token = 'ok'

  const grant = await readGrant(token)
  if (!grant.ok) return finish('metaError', { grant: grant.reason })
  const pages = grant.pages
  Object.assign(trace, { assignedReturned: grant.assigned, accountsReturned: grant.accounts, pages: pages.length, disagree: grant.disagree, accounts: accountsSummary(pages) })

  if (pending.channel_id) {
    // A reconnect: the channel keeps its account, or nothing changes
    const { data: channel } = await admin
      .from('channels')
      .select('id, client_id, type, external_id')
      .eq('id', pending.channel_id)
      .maybeSingle<{ id: string; client_id: string; type: string; external_id: string | null }>()
    if (!channel || channel.client_id !== pending.client_id || !channel.external_id) return finish('forbidden', { reconnect: 'channel_not_found' })
    Object.assign(trace, { channelType: channel.type, account: channel.external_id })

    let channelToken: string | null = null
    if (channel.type === 'facebook') {
      // Only a Page the clinic offered keeps Messenger: one carried in by Instagram is not shared
      const page = pages.find((p) => p.id === channel.external_id && pageOffered(p.tasks))
      channelToken = page?.pageToken ?? null
    } else if (channel.type === 'instagram') {
      channelToken = pages.some((p) => p.instagram?.id === channel.external_id) ? token : null
    }
    if (!channelToken) return finish('notShared', { reconnect: 'account_not_shared' })
    // Never store a token we have not just seen work
    if (!(await verifyAccess({ objectId: channel.external_id, token: channelToken }))) return finish('metaError', { reconnect: 'token_did_not_verify' })

    const attached = await attachToken({
      admin,
      channelId: channel.id,
      type: channel.type as 'facebook' | 'instagram',
      externalId: channel.external_id,
      token: channelToken,
      appId: config.appId,
    })
    return finish(attachedStatus([attached], false), { reconnect: 'refreshed', subscribed: attached.subscribed, messagesBlocked: attached.messagesBlocked })
  }

  const options = connectOptions(pages)
  Object.assign(trace, {
    options: options.length,
    messengerOffered: options.filter((o) => o.messenger).length,
    instagramOffered: options.filter((o) => o.instagram).length,
  })
  if (options.length === 0) return finish('empty')

  // The token waits here, never in the browser, for the clinic's pick
  const { error } = await admin
    .from('meta_connect_pending')
    .update({ access_token: token, options, expires_at: new Date(Date.now() + CONNECT_TTL_MS).toISOString() })
    .eq('id', pending.id)
  if (error) return finish('unknown', { keep: 'failed', dbCode: error.code })
  logConnect({ ...trace, outcome: 'picker' })
  return Response.redirect(`${origin}${channelsPath}/connect/${pending.id}`, 303)
}

function redirectTo(origin: string, path: string, status: ConnectStatus) {
  return Response.redirect(`${origin}${path}?connect=${status}`, 303)
}
