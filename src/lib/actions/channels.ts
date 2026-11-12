'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession, isImpersonating } from '@/lib/auth/session'
import { appOrigin } from '@/lib/app-url'
import { subscribeApp, subscribedApps, type SubscriptionState } from '@/lib/meta/subscription'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkClientLimit, guardLimit, limitErrorFromDb } from '@/lib/subscription-limits'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  AVAILABLE_CHANNEL_TYPES,
  CHANNEL_TYPES,
  COMMENT_CHANNEL_TYPES,
  type Channel,
  type ChannelActionResult,
  type ChannelType,
} from '@/lib/types/channels'
import { errorForLog } from '@/lib/log'

const CHANNELS_PATH = '/[locale]/dashboard/clients/[clientId]/channels'
const CHANNEL_COLUMNS = 'id, client_id, type, name, webhook_url, is_active, created_at, connection_notice, comment_replies_enabled, comment_replies_changed_by, comment_replies_changed_at'

function dbError(error: { code?: string; message: string; hint?: string | null }): ChannelActionResult {
  // The subscription limit trigger (a race past the check in createChannelAction)
  const limit = limitErrorFromDb(error)
  if (limit) return { ok: false, error: limit }
  // 42501 = insufficient_privilege (RLS rejected the write)
  if (error.code === '42501') return { ok: false, error: 'forbidden' }
  console.error('[channels]', errorForLog(error))
  return { ok: false, error: 'unknown' }
}

export async function getChannels(clientId: string): Promise<Channel[]> {
  if (!UUID_PATTERN.test(clientId)) return []
  const { supabase, profile } = await getSession()
  // Channels are managed by client admins and up; team members don't see them
  if (!profile || !canManage(profile)) return []

  // RLS limits rows to channels of clients the current user has access to
  const { data, error } = await supabase
    .from('channels')
    .select(CHANNEL_COLUMNS)
    .eq('client_id', clientId)
    .order('created_at', { ascending: true })
    .returns<(Channel & { comment_replies_changed_by: string | null })[]>()

  if (error) throw new Error(`Failed to load channels: ${error.code}`)
  // Who last flipped comment replies, by name. The ids are on rows this user may see (RLS above);
  // the names are read with the service role because a manager may not see every colleague's row
  const changers = [...new Set(data.map((row) => row.comment_replies_changed_by).filter((id): id is string => !!id))]
  const names = new Map<string, string>()
  if (changers.length > 0) {
    const { data: users, error: usersError } = await createAdminClient().from('users').select('id, full_name, email').in('id', changers)
    if (usersError) console.error('[channels] comment replies changed by', errorForLog(usersError))
    for (const user of (users ?? []) as { id: string; full_name: string | null; email: string }[]) names.set(user.id, user.full_name?.trim() || user.email)
  }
  return data.map(({ comment_replies_changed_by: by, ...channel }) => ({
    ...channel,
    comment_replies_changed_by_name: by ? (names.get(by) ?? null) : null,
  }))
}

/**
 * Comment replies on one Facebook or Instagram channel, on or off. Who and
 * when are stamped by the database (20261119100000), never sent from here.
 * Managers only, as every other channel change; never while impersonating.
 */
export async function setCommentRepliesAction(channelId: string, enabled: boolean): Promise<ChannelActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(channelId) || typeof enabled !== 'boolean') return { ok: false, error: 'validation' }

  const { data, error } = await supabase
    .from('channels')
    .update({ comment_replies_enabled: enabled })
    .eq('id', channelId)
    .in('type', COMMENT_CHANNEL_TYPES as ChannelType[])
    .select('id')
  if (error) return dbError(error)
  // RLS, or a channel that is not Facebook or Instagram: zero rows
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }
  console.info('[channels] comment replies', { channelId, enabled })
  revalidatePath(CHANNELS_PATH, 'page')
  return { ok: true }
}

export async function createChannelAction(
  clientId: string,
  formData: FormData
): Promise<ChannelActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(clientId)) return { ok: false, error: 'notFound' }

  const type = String(formData.get('type') ?? '')
  const name = String(formData.get('name') ?? '').trim()

  if (!(CHANNEL_TYPES as readonly string[]).includes(type)) {
    return { ok: false, error: 'validation' }
  }
  if (!AVAILABLE_CHANNEL_TYPES.includes(type as ChannelType)) {
    return { ok: false, error: 'comingSoon' }
  }
  if (!name) return { ok: false, error: 'validation', fieldErrors: { name: 'nameRequired' } }
  if (name.length > 100) {
    return { ok: false, error: 'validation', fieldErrors: { name: 'nameTooLong' } }
  }

  // RLS: only clients this user can see
  const { data: client } = await supabase
    .from('clients')
    .select('id')
    .eq('id', clientId)
    .maybeSingle<{ id: string }>()
  if (!client) return { ok: false, error: 'notFound' }

  // Channels count against the client's own plan
  const blocked = await guardLimit(checkClientLimit(supabase, clientId, 'channels'))
  if (blocked) return { ok: false, error: blocked }

  const id = crypto.randomUUID()
  // Stored for reference; embed codes are always built from the current origin
  const webhookUrl = `${await appOrigin()}/api/webhook/website/${id}`

  const { error } = await supabase.from('channels').insert({
    id,
    client_id: clientId,
    type,
    name,
    webhook_url: webhookUrl,
    is_active: true,
  })

  if (error) return dbError(error)

  revalidatePath(CHANNELS_PATH, 'page')
  return { ok: true }
}

export async function toggleChannelActive(
  id: string,
  isActive: boolean
): Promise<ChannelActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(id)) return { ok: false, error: 'notFound' }

  // Turning a paused channel on takes a seat: checked here, and by the database (20261112100000)
  if (isActive) {
    const { data: channel } = await supabase.from('channels').select('client_id, is_active').eq('id', id).maybeSingle<{ client_id: string; is_active: boolean }>()
    if (!channel) return { ok: false, error: 'notFound' }
    if (!channel.is_active) {
      const blocked = await guardLimit(checkClientLimit(supabase, channel.client_id, 'channels'))
      if (blocked) return { ok: false, error: blocked }
    }
  }

  const { data, error } = await supabase
    .from('channels')
    .update({ is_active: isActive })
    .eq('id', id)
    .select('id')

  if (error) return dbError(error)
  // RLS filters out rows the user can't touch, which shows up as zero rows
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(CHANNELS_PATH, 'page')
  return { ok: true }
}

export async function deleteChannelAction(id: string): Promise<ChannelActionResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(id)) return { ok: false, error: 'notFound' }

  const { data, error } = await supabase.from('channels').delete().eq('id', id).select('id')

  if (error) return dbError(error)
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(CHANNELS_PATH, 'page')
  return { ok: true }
}

/**
 * Whether a WhatsApp channel's WABA is subscribed to our app, asked of Meta
 * each time: the state to show wherever the channel is inspected. A channel
 * whose WABA is not subscribed is not connected, whatever else is green
 * (.scratch/whatsapp-send-design.md §5). The token stays on the server: the
 * session client only proves the caller may see the channel.
 */
export async function getWhatsappSubscription(channelId: string): Promise<SubscriptionState | { kind: 'notFound' }> {
  const { supabase, profile } = await getSession()
  if (!profile || !canManage(profile)) return { kind: 'notFound' }
  if (!UUID_PATTERN.test(channelId)) return { kind: 'notFound' }
  const { data: channel } = await supabase.from('channels').select('id').eq('id', channelId).eq('type', 'whatsapp').maybeSingle<{ id: string }>()
  if (!channel) return { kind: 'notFound' }
  return subscribedApps({ supabase: createAdminClient(), channelId })
}

/** The connect step: subscribes the channel's WABA to our app and reads the state back */
export async function subscribeWhatsappAction(channelId: string): Promise<SubscriptionState | { kind: 'notFound' } | { kind: 'impersonating' }> {
  if (await isImpersonating()) return { kind: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile || !canManage(profile)) return { kind: 'notFound' }
  if (!UUID_PATTERN.test(channelId)) return { kind: 'notFound' }
  const { data: channel } = await supabase.from('channels').select('id').eq('id', channelId).eq('type', 'whatsapp').maybeSingle<{ id: string }>()
  if (!channel) return { kind: 'notFound' }
  const state = await subscribeApp({ supabase: createAdminClient(), channelId })
  revalidatePath(CHANNELS_PATH, 'page')
  return state
}
