'use server'

import { randomBytes } from 'node:crypto'
import { headers } from 'next/headers'
import { revalidatePath } from 'next/cache'
import { canManage, getSession } from '@/lib/auth/session'
import { appOrigin } from '@/lib/app-url'
import { dialogUrl, listPages, pageOffered } from '@/lib/meta/connect'
import {
  CONNECT_TTL_MS,
  PENDING_COLUMNS,
  attachToken,
  attachedStatus,
  callbackUrl,
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
  const caller = await manager(clientId)
  if (!caller.ok) return { ok: false, status: caller.error }
  const config = metaConfig()
  if (!config) return { ok: false, status: 'notConfigured' }
  const lang = locale === 'en' ? 'en' : 'ar'

  if (channelId !== null) {
    if (!UUID_PATTERN.test(channelId)) return { ok: false, status: 'forbidden' }
    const { data: channel } = await caller.supabase
      .from('channels')
      .select('id, type')
      .eq('id', channelId)
      .eq('client_id', clientId)
      .in('type', ['facebook', 'instagram'])
      .maybeSingle<{ id: string }>()
    if (!channel) return { ok: false, status: 'forbidden' }
  }

  // The session cookie must reach the callback: the login starts on the callback's own host
  const callback = await callbackUrl()
  const h = await headers()
  const host = h.get('x-forwarded-host') ?? h.get('host')
  if (host && new URL(callback).host !== host) {
    return { ok: true, url: `${await appOrigin()}/${lang}/dashboard/clients/${clientId}/channels` }
  }

  const admin = createAdminClient()
  await sweepExpired(admin)
  await admin.from('meta_connect_pending').delete().eq('user_id', caller.profile.id).eq('client_id', clientId)

  const state = randomBytes(32).toString('base64url')
  const { error } = await admin.from('meta_connect_pending').insert({
    state,
    user_id: caller.profile.id,
    client_id: clientId,
    channel_id: channelId,
    locale: lang,
    expires_at: new Date(Date.now() + CONNECT_TTL_MS).toISOString(),
  })
  if (error) {
    console.error('[meta/connect] could not start', { code: error.code })
    return { ok: false, status: 'unknown' }
  }
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
  if (!pending?.options) return null
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
  return { pendingId, clientId, clientName: caller.client.name, options }
}

/** The clinic leaves the picker: the token goes */
export async function cancelMetaConnect(pendingId: string, clientId: string): Promise<CompleteConnectResult> {
  const { profile } = await getSession()
  if (profile && UUID_PATTERN.test(pendingId)) {
    await createAdminClient().from('meta_connect_pending').delete().eq('id', pendingId).eq('user_id', profile.id).eq('client_id', clientId)
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
 */
export async function completeMetaConnect(pendingId: string, clientId: string, selection: PickerSelection): Promise<CompleteConnectResult> {
  const caller = await manager(clientId)
  if (!caller.ok) return { ok: false, status: caller.error }
  const config = metaConfig()
  if (!config) return { ok: false, status: 'notConfigured' }
  const pending = await pendingPick(pendingId, clientId, caller.profile.id)
  if (!pending?.options || !pending.access_token) return { ok: false, status: 'expired' }
  const systemToken = pending.access_token

  const option = pending.options.find((o) => o.pageId === selection.pageId)
  if (!option) return { ok: false, status: 'forbidden' }
  if (selection.messenger && !option.messenger) return { ok: false, status: 'forbidden' }
  if (selection.instagram && !option.instagram) return { ok: false, status: 'forbidden' }
  if (!selection.messenger && !selection.instagram) return { ok: false, status: 'forbidden' }

  // The Page token is read now, from Meta, and the Page must still be the clinic's own offer
  const pages = await listPages(systemToken)
  if (!pages) return { ok: false, status: 'metaError' }
  const page = pages.find((p) => p.id === option.pageId)

  const admin = createAdminClient()
  const planned: Planned[] = []
  if (selection.messenger) {
    if (!page?.pageToken || !pageOffered(page.tasks)) return { ok: false, status: 'metaError' }
    const held = await occupancy(admin, clientId, 'facebook', option.pageId)
    if (held.availability === 'otherClient') return { ok: false, status: 'accountOnOtherClient' }
    planned.push({ type: 'facebook', externalId: option.pageId, name: option.pageName, token: page.pageToken, existingId: held.channelId })
  }
  if (selection.instagram && option.instagram) {
    if (page?.instagram?.id !== option.instagram.id) return { ok: false, status: 'metaError' }
    const held = await occupancy(admin, clientId, 'instagram', option.instagram.id)
    if (held.availability === 'otherClient') return { ok: false, status: 'accountOnOtherClient' }
    const name = option.instagram.username ? `@${option.instagram.username}` : option.instagram.id
    planned.push({ type: 'instagram', externalId: option.instagram.id, name, token: systemToken, existingId: held.channelId })
  }

  // Seats: every new channel, counted together, before any is created
  const needed = planned.filter((p) => !p.existingId).length
  if (needed > 0) {
    let check
    try {
      check = await checkClientLimit(caller.supabase, clientId, 'channels')
    } catch (error) {
      console.error('[meta/connect] seat check', error)
      return { ok: false, status: 'unknown' }
    }
    if (check?.reason === 'inactive') return { ok: false, status: 'subscriptionInactive' }
    if (check && check.limit !== null) {
      const free = check.limit - check.used
      if (free < needed) return { ok: false, status: needed === 2 && free === 1 ? 'limitReachedTwo' : 'limitReached' }
    }
  }

  const results: AttachResult[] = []
  for (const item of planned) {
    let channelId = item.existingId
    if (!channelId) {
      // As the user: row level security decides, as for any channel they add
      const { data, error } = await caller.supabase
        .from('channels')
        .insert({ client_id: clientId, type: item.type, name: item.name.slice(0, 100), external_id: item.externalId, is_active: true })
        .select('id')
        .single<{ id: string }>()
      if (error) return { ok: false, status: insertError(error) }
      channelId = data.id
    }
    try {
      results.push(await attachToken({ admin, channelId, type: item.type, externalId: item.externalId, token: item.token, appId: config.appId }))
    } catch (error) {
      console.error('[meta/connect] could not store the token', { channelId, type: item.type, error: error instanceof Error ? error.message : String(error) })
      // A new channel with no token is not a channel: it goes; an existing one keeps what it had
      if (!item.existingId) await admin.from('channels').delete().eq('id', channelId)
      return { ok: false, status: 'unknown' }
    }
  }

  await admin.from('meta_connect_pending').delete().eq('id', pending.id)
  revalidatePath(CHANNELS_PATH, 'page')
  return { ok: true, status: attachedStatus(results, needed === 0) }
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
