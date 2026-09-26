'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession } from '@/lib/auth/session'
import { appOrigin } from '@/lib/app-url'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  AVAILABLE_CHANNEL_TYPES,
  CHANNEL_TYPES,
  type Channel,
  type ChannelActionResult,
  type ChannelType,
} from '@/lib/types/channels'

const CHANNELS_PATH = '/[locale]/dashboard/clients/[clientId]/channels'
const CHANNEL_COLUMNS = 'id, client_id, type, name, webhook_url, is_active, created_at'

function dbError(error: { code?: string; message: string }): ChannelActionResult {
  // 42501 = insufficient_privilege (RLS rejected the write)
  if (error.code === '42501') return { ok: false, error: 'forbidden' }
  console.error('[channels]', error)
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
    .returns<Channel[]>()

  if (error) throw new Error(`Failed to load channels: ${error.message}`)
  return data
}

export async function createChannelAction(
  clientId: string,
  formData: FormData
): Promise<ChannelActionResult> {
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

  const id = crypto.randomUUID()
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
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(id)) return { ok: false, error: 'notFound' }

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
