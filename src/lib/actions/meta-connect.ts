'use server'

import { randomBytes } from 'node:crypto'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { canManage, getSession } from '@/lib/auth/session'
import { appOrigin } from '@/lib/app-url'
import { dialogUrl, pageOffered, readGrant, verifyAccess } from '@/lib/meta/connect'
import {
  CONNECT_TTL_MS,
  PENDING_COLUMNS,
  accountsSummary,
  attachToken,
  attachedStatus,
  callbackUrl,
  logConnect,
  metaConfig,
  occupancy,
  sweepExpired,
  type AttachResult,
  type PendingRow,
} from '@/lib/meta/connect-flow'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkClientLimit, limitErrorFromDb } from '@/lib/subscription-limits'
import { UUID_PATTERN } from '@/lib/types/clients'
import type {
  CompleteConnectResult,
  ConnectStatus,
  PickerOption,
  PickerSelection,
  PickerView,
  StartConnectResult,
} from '@/lib/types/meta-connect'

const CHANNELS_PATH = '/[locale]/dashboard/clients/[clientId]/channels'

/** The caller, allowed to manage this client's channels, or why not */
async function manager(
  clientId: string
): Promise<{ ok: false; error: 'forbidden' | 'impersonating' } | { ok: true; supabase: Awaited<ReturnType<typeof getSession>>['supabase']; profile: NonNullable<Awaited<ReturnType<typeof getSession>>['profile']>; client: { id: string; name: string } }> {
  const { supabase, profile, impersonation } = await getSession()
  if (!profile) return { ok: false, error: 'forbidden' }
  if (impersonation) return { ok: false, error: 'impersonating' }
  if (!canManage(profile) || !UUID_PATTERN.test(clientId)) return { ok: false, error: 'forbidden' }
  // RLS: only clients this user can see
  const { data: client } = await supabase.from('clients').select('id, name').eq('id', clientId).maybeSingle<{ id: string; name: string }>()
  if (!client) return { ok: false, error: 'forbidden' }
  return { ok: true, supabase, profile, client }
}

/**
 * Starts a Page and Instagram login for a client, or a reconnect of one of
 * its Meta channels (which keeps its account). The state is bound
 * server-side to this user, this client and the flow; the user's earlier
 * connects for this client are dropped, so a double click leaves no live
 * token behind. Returns Meta's dialog URL.
 */
export async function startMetaConnect(clientId: string, locale: string, channelId: string | null = null): Promise<StartConnectResult> {
  const flow = channelId === null ? 'connect' : 'reconnect'
  const refused = (status: ConnectStatus, why: Record<string, unknown> = {}): StartConnectResult => {
    logConnect({ step: 'start', clientId, flow, channelId: channelId ?? undefined, ...why, outcome: status })
    return { ok: false, status }
  }
  const caller = await manager(clientId)
  if (!caller.ok) return refused(caller.error)
  const config = metaConfig()
  if (!config) return refused('notConfigured')
  const lang = locale === 'en' ? 'en' : 'ar'

  if (channelId !== null) {
    if (!UUID_PATTERN.test(channelId)) return refused('forbidden', { channel: 'invalid' })
    const { data: channel } = await caller.supabase
      .from('channels')
      .select('id, type')
      .eq('id', channelId)
      .eq('client_id', clientId)
      .in('type', ['facebook', 'instagram'])
      .maybeSingle<{ id: string }>()
    if (!channel) return refused('forbidden', { channel: 'not_found' })
  }

  // The session cookie must reach the callback: the login starts on the callback's own host
  const callback = await callbackUrl()
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  if (host && new URL(callback).host !== host) {
    logConnect({ step: 'start', clientId, flow, outcome: 'moved_to_callback_host' })
    return { ok: true, url: `${await appOrigin()}/${lang}/dashboard/clients/${clientId}/channels` }
  }

  const admin = createAdminClient()
  await sweepExpired(admin)
  const { count: dropped } = await admin.from('meta_connect_pending').delete({ count: 'exact' }).eq('user_id', caller.profile.id).eq('client_id', clientId)

  const state = randomBytes(32).toString('base64url')
  const { data: row, error } = await admin.from('meta_connect_pending').insert({
    state,
    user_id: caller.profile.id,
    client_id: clientId,
    channel_id: channelId,
    locale: lang,
    expires_at: new Date(Date.now() + CONNECT_TTL_MS).toISOString(),
  }).select('id').single<{ id: string }>()
  if (error) return refused('unknown', { dbCode: error.code })
  // Dropped: this user's earlier connects for the client (a double click, or a login abandoned in Meta's dialog)
  logConnect({ step: 'start', clientId, flow, channelId: channelId ?? undefined, pendingId: row.id, droppedEarlier: dropped ?? 0, outcome: 'sent_to_meta' })
  return { ok: true, url: dialogUrl({ appId: config.appId, configId: config.configId, redirectUri: callback, state }) }
}

/** The caller's own pick in progress for this client, within its time, or null */
async function pendingPick(pendingId: string, clientId: string, userId: string): Promise<PendingRow | null> {
  if (!UUID_PATTERN.test(pendingId)) return null
  const { data } = await createAdminClient()
    .from('meta_connect_pending')
    .select(PENDING_COLUMNS)
    .eq('id', pendingId)
    .eq('user_id', userId)
    .eq('client_id', clientId)
    .is('channel_id', null)
    .not('access_token', 'is', null)
    .gt('expires_at', new Date().toISOString())
    .maybeSingle<PendingRow>()
  return data ?? null
}

/** The picker's choices, with who holds each account now. null: nothing to pick (expired, or not this user's) */
export async function getMetaConnectPicker(pendingId: string, clientId: string): Promise<PickerView | null> {
  const caller = await manager(clientId)
  if (!caller.ok) return null
  const pending = await pendingPick(pendingId, clientId, caller.profile.id)
  if (!pending?.options) {
    logConnect({ step: 'picker', pendingId, clientId, outcome: 'expired' })
    return null
  }
  const admin = createAdminClient()
  const options: PickerOption[] = await Promise.all(
    pending.options.map(async (option) => ({
      pageId: option.pageId,
      pageName: option.pageName,
      messenger: option.messenger ? (await occupancy(admin, clientId, 'facebook', option.pageId)).availability : null,
      instagram: option.instagram
        ? { username: option.instagram.username, availability: (await occupancy(admin, clientId, 'instagram', option.instagram.id)).availability }
        : null,
    }))
  )
  logConnect({
    step: 'picker',
    pendingId,
    clientId,
    shown: options.map((o) => ({ page: o.pageId, messenger: o.messenger, instagram: o.instagram?.availability ?? null })),
    outcome: 'shown',
  })
  return { pendingId, clientId, clientName: caller.client.name, options }
}

/** The clinic leaves the picker: the token goes */
export async function cancelMetaConnect(pendingId: string, clientId: string): Promise<CompleteConnectResult> {
  const { profile } = await getSession()
  if (profile && UUID_PATTERN.test(pendingId)) {
    const { count } = await createAdminClient().from('meta_connect_pending').delete({ count: 'exact' }).eq('id', pendingId).eq('user_id', profile.id).eq('client_id', clientId)
    logConnect({ step: 'pick', pendingId, clientId, deleted: count ?? 0, outcome: 'cancelled' })
  }
  return { ok: true, status: 'cancelled' }
}

type Planned = { type: 'facebook' | 'instagram'; externalId: string; name: string; token: string; existingId: string | null }

/**
 * The clinic's pick: one Page, and which of its channels. What is ticked is
 * what is connected. Only a choice the server offered is accepted, Messenger
 * only for a Page the clinic itself granted, and an account held by any other
 * client (active or paused) is refused before the database's index sees it.
 * Both seats are checked before either channel is created.
 *
 * A NEW CHANNEL IS CREATED PAUSED. It does not answer anyone until someone
 * who has checked what the bot says turns it on from its card: a clinic that
 * connects at eleven at night must not have the bot talking to patients
 * (user, 2026-11-05; the same principle as the comment switch). A channel
 * that is refreshed keeps the state it had.
 */
export async function completeMetaConnect(pendingId: string, clientId: string, selection: PickerSelection): Promise<CompleteConnectResult> {
  // What the clinic picked, and every decision after it: one line at the end
  const trace: Record<string, unknown> = { step: 'pick', pendingId, clientId, picked: { page: selection.pageId, messenger: selection.messenger, instagram: selection.instagram } }
  const done = (result: CompleteConnectResult, why: Record<string, unknown> = {}): CompleteConnectResult => {
    logConnect({ ...trace, ...why, outcome: result.status })
    return result
  }
  const caller = await manager(clientId)
  if (!caller.ok) return done({ ok: false, status: caller.error })
  const config = metaConfig()
  if (!config) return done({ ok: false, status: 'notConfigured' })
  const pending = await pendingPick(pendingId, clientId, caller.profile.id)
  if (!pending?.options || !pending.access_token) return done({ ok: false, status: 'expired' })
  const systemToken = pending.access_token

  const option = pending.options.find((o) => o.pageId === selection.pageId)
  if (!option) return done({ ok: false, status: 'forbidden' }, { refused: 'not_offered_page' })
  if (selection.messenger && !option.messenger) return done({ ok: false, status: 'forbidden' }, { refused: 'messenger_not_offered' })
  if (selection.instagram && !option.instagram) return done({ ok: false, status: 'forbidden' }, { refused: 'no_instagram' })
  if (!selection.messenger && !selection.instagram) return done({ ok: false, status: 'forbidden' }, { refused: 'nothing_ticked' })

  // The Page token is read now, from Meta, and the Page must still be the clinic's own offer
  const grant = await readGrant(systemToken)
  if (!grant.ok) return done({ ok: false, status: 'metaError' }, { grant: grant.reason })
  const page = grant.pages.find((p) => p.id === option.pageId)

  const admin = createAdminClient()
  const planned: Planned[] = []
  if (selection.messenger) {
    if (!page?.pageToken || !pageOffered(page.tasks)) return done({ ok: false, status: 'metaError' }, { refused: 'page_no_longer_offered', account: page ? accountsSummary([page])[0] : 'gone' })
    const held = await occupancy(admin, clientId, 'facebook', option.pageId)
    if (held.availability === 'otherClient') return done({ ok: false, status: 'accountOnOtherClient' }, { refused: 'page_on_other_client' })
    planned.push({ type: 'facebook', externalId: option.pageId, name: option.pageName, token: page.pageToken, existingId: held.channelId })
  }
  if (selection.instagram && option.instagram) {
    if (page?.instagram?.id !== option.instagram.id) return done({ ok: false, status: 'metaError' }, { refused: 'instagram_no_longer_linked' })
    const held = await occupancy(admin, clientId, 'instagram', option.instagram.id)
    if (held.availability === 'otherClient') return done({ ok: false, status: 'accountOnOtherClient' }, { refused: 'instagram_on_other_client' })
    const name = option.instagram.username ? `@${option.instagram.username}` : option.instagram.id
    planned.push({ type: 'instagram', externalId: option.instagram.id, name, token: systemToken, existingId: held.channelId })
  }

  // Seats: every new channel, counted together, before any is created
  const needed = planned.filter((p) => !p.existingId).length
  trace.newChannels = needed
  trace.refreshed = planned.length - needed
  if (needed > 0) {
    let check
    try {
      check = await checkClientLimit(caller.supabase, clientId, 'channels')
    } catch (error) {
      console.error('[meta/connect] seat check', error)
      return done({ ok: false, status: 'unknown' }, { seats: 'check_failed' })
    }
    if (check?.reason === 'inactive') return done({ ok: false, status: 'subscriptionInactive' })
    if (check && check.limit !== null) {
      const free = check.limit - check.used
      if (free < needed) return done({ ok: false, status: needed === 2 && free === 1 ? 'limitReachedTwo' : 'limitReached' }, { seats: { needed, free } })
    }
  }

  // Every token, seen to work on its account just now, before anything is created or stored
  for (const item of planned) {
    if (!(await verifyAccess({ objectId: item.externalId, token: item.token }))) {
      return done({ ok: false, status: 'metaError' }, { refused: 'token_did_not_verify', type: item.type, account: item.externalId })
    }
  }

  const results: AttachResult[] = []
  const attached: Record<string, unknown>[] = []
  for (const item of planned) {
    let channelId = item.existingId
    if (!channelId) {
      // As the user: row level security decides, as for any channel they add
      const { data, error } = await caller.supabase
        .from('channels')
        .insert({ client_id: clientId, type: item.type, name: item.name.slice(0, 100), external_id: item.externalId, is_active: false })
        .select('id')
        .single<{ id: string }>()
      if (error) return done({ ok: false, status: insertError(error) }, { attached, insertFailed: { type: item.type, dbCode: error.code } })
      channelId = data.id
    }
    try {
      const result = await attachToken({ admin, channelId, type: item.type, externalId: item.externalId, token: item.token, appId: config.appId })
      results.push(result)
      attached.push({ channelId, type: item.type, account: item.externalId, created: !item.existingId, subscribed: result.subscribed, messagesBlocked: result.messagesBlocked })
    } catch (error) {
      console.error('[meta/connect] could not store the token', { channelId, type: item.type, error: error instanceof Error ? error.message : String(error) })
      // A new channel with no token is not a channel: it goes; an existing one keeps what it had
      if (!item.existingId) await admin.from('channels').delete().eq('id', channelId)
      return done({ ok: false, status: 'unknown' }, { attached, tokenStoreFailed: { channelId, type: item.type } })
    }
  }

  await admin.from('meta_connect_pending').delete().eq('id', pending.id)
  revalidatePath(CHANNELS_PATH, 'page')
  return done({ ok: true, status: attachedStatus(results, needed > 0) }, { attached })
}

function insertError(error: { code?: string; message: string; hint?: string | null }): ConnectStatus {
  const limit = limitErrorFromDb(error)
  if (limit) return limit
  // The one active channel per account index (20261110100000): the last guard, behind occupancy()
  if (error.code === '23505') return 'accountOnOtherClient'
  if (error.code === '42501') return 'forbidden'
  console.error('[meta/connect] channel insert', { code: error.code })
  return 'unknown'
}
