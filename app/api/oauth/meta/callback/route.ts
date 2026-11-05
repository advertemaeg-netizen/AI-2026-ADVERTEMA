import type { NextRequest } from 'next/server'
import { appOrigin } from '@/lib/app-url'
import { canManage, getSession } from '@/lib/auth/session'
import { checkToken, connectOptions, exchangeCode, listPages, pageOffered } from '@/lib/meta/connect'
import { CONNECT_TTL_MS, PENDING_COLUMNS, attachToken, attachedStatus, callbackUrl, metaConfig, type PendingRow } from '@/lib/meta/connect-flow'
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
 *      Then the accounts it can see (/me/accounts).
 *   5–6. A reconnect refreshes its own channel here, if its account is among
 *      them, and subscribes it again; it never moves to another account. A
 *      new connect keeps the token server-side and sends the clinic to the
 *      picker, which does the rest.
 *   8. Every redirect carries a status and nothing else.
 *
 * Never logged: the code, the state, the token.
 */
export async function GET(request: NextRequest) {
  const params = request.nextUrl.searchParams
  const origin = await appOrigin()
  const admin = createAdminClient()

  const state = params.get('state')
  if (!state) return redirectTo(origin, `/${routing.defaultLocale}/dashboard/clients`, 'expired')

  // Single use: whoever reads it first takes it, a replay finds nothing
  const { data: pending } = await admin
    .from('meta_connect_pending')
    .update({ state: null })
    .eq('state', state)
    .gt('expires_at', new Date().toISOString())
    .select(PENDING_COLUMNS)
    .maybeSingle<PendingRow>()
  if (!pending) return redirectTo(origin, `/${routing.defaultLocale}/dashboard/clients`, 'expired')

  const channelsPath = `/${pending.locale}/dashboard/clients/${pending.client_id}/channels`
  const finish = async (status: ConnectStatus) => {
    await admin.from('meta_connect_pending').delete().eq('id', pending.id)
    return redirectTo(origin, channelsPath, status)
  }

  const { supabase, profile, impersonation } = await getSession()
  if (!profile || impersonation || profile.id !== pending.user_id || !canManage(profile)) return finish('forbidden')
  const { data: client } = await supabase.from('clients').select('id').eq('id', pending.client_id).maybeSingle<{ id: string }>()
  if (!client) return finish('forbidden')

  if (params.get('error') || params.get('error_reason')) return finish('cancelled')
  const code = params.get('code')
  if (!code) return finish('cancelled')

  const config = metaConfig()
  if (!config) return finish('notConfigured')

  const token = await exchangeCode({ code, redirectUri: await callbackUrl(), appId: config.appId, appSecret: config.appSecret })
  if (!token) return finish('metaError')

  const check = await checkToken({ token, appId: config.appId, appSecret: config.appSecret })
  if (check.kind === 'missingPermission') return finish('missingPermission')
  if (check.kind !== 'ok') return finish('metaError')

  const pages = await listPages(token)
  if (!pages) return finish('metaError')

  if (pending.channel_id) {
    // A reconnect: the channel keeps its account, or nothing changes
    const { data: channel } = await admin
      .from('channels')
      .select('id, client_id, type, external_id')
      .eq('id', pending.channel_id)
      .maybeSingle<{ id: string; client_id: string; type: string; external_id: string | null }>()
    if (!channel || channel.client_id !== pending.client_id || !channel.external_id) return finish('forbidden')

    let channelToken: string | null = null
    if (channel.type === 'facebook') {
      // Only a Page the clinic offered keeps Messenger: one carried in by Instagram is not shared
      const page = pages.find((p) => p.id === channel.external_id && pageOffered(p.tasks))
      channelToken = page?.pageToken ?? null
    } else if (channel.type === 'instagram') {
      channelToken = pages.some((p) => p.instagram?.id === channel.external_id) ? token : null
    }
    if (!channelToken) return finish('notShared')

    const attached = await attachToken({
      admin,
      channelId: channel.id,
      type: channel.type as 'facebook' | 'instagram',
      externalId: channel.external_id,
      token: channelToken,
      appId: config.appId,
    })
    return finish(attachedStatus([attached], false))
  }

  const options = connectOptions(pages)
  if (options.length === 0) return finish('empty')

  // The token waits here, never in the browser, for the clinic's pick
  const { error } = await admin
    .from('meta_connect_pending')
    .update({ access_token: token, options, expires_at: new Date(Date.now() + CONNECT_TTL_MS).toISOString() })
    .eq('id', pending.id)
  if (error) {
    console.error('[meta/connect] could not keep the token for the picker', { code: error.code })
    return finish('unknown')
  }
  return Response.redirect(`${origin}${channelsPath}/connect/${pending.id}`, 303)
}

function redirectTo(origin: string, path: string, status: ConnectStatus) {
  return Response.redirect(`${origin}${path}?connect=${status}`, 303)
}
