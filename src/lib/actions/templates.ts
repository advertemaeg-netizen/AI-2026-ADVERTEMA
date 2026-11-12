'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession } from '@/lib/auth/session'
import { manager } from '@/lib/meta/connect-manager'
import { createTemplate, listTemplates } from '@/lib/meta/templates'
import { createAdminClient } from '@/lib/supabase/admin'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  templateInputSchema,
  templateStatus,
  type ChannelTemplates,
  type TemplateCreateResult,
} from '@/lib/types/templates'

const TEMPLATES_PATH = '/[locale]/dashboard/clients/[clientId]/templates'

/** The client's WhatsApp channels that this user can see (RLS), oldest first */
async function whatsappChannels(clientId: string, channelId?: string) {
  const { supabase } = await getSession()
  let query = supabase.from('channels').select('id, name').eq('client_id', clientId).eq('type', 'whatsapp')
  if (channelId) query = query.eq('id', channelId)
  const { data, error } = await query.order('created_at', { ascending: true }).returns<{ id: string; name: string }[]>()
  if (error) throw new Error(`channels read failed: ${error.code}`)
  return data
}

/**
 * Each WhatsApp channel's templates, read live from Meta. A channel without
 * a token or WABA id is left out; none left means the screen offers to
 * connect WhatsApp. A failed read throws, and the page shows its error
 * screen: an empty list would read as "no templates", which is a lie.
 */
export async function getTemplates(clientId: string): Promise<ChannelTemplates[]> {
  if (!UUID_PATTERN.test(clientId)) return []
  const { profile } = await getSession()
  if (!profile || !canManage(profile)) return []
  const channels = await whatsappChannels(clientId)
  if (channels.length === 0) return []
  const admin = createAdminClient()
  const results = await Promise.all(
    channels.map(async (channel) => ({ channel, result: await listTemplates({ supabase: admin, channelId: channel.id }) }))
  )
  const lists: ChannelTemplates[] = []
  for (const { channel, result } of results) {
    if (result.kind === 'failed') throw new Error(`template list failed: status ${result.status}, code ${result.code}`)
    if (result.kind === 'ok') lists.push({ channelId: channel.id, channelName: channel.name, templates: result.templates })
  }
  return lists
}

/**
 * Submits a template for Meta's review, as UTILITY (src/lib/meta/templates.ts).
 * "Name taken" is decided from the live list before submitting: the same
 * name in the same language. The same name in another language is allowed,
 * as Meta allows it (that is how one template has several languages).
 */
export async function createTemplateAction(clientId: string, channelId: string, input: unknown): Promise<TemplateCreateResult> {
  const caller = await manager(clientId)
  if (!caller.ok) return { ok: false, error: caller.error }
  if (!UUID_PATTERN.test(channelId)) return { ok: false, error: 'forbidden' }
  const parsed = templateInputSchema.safeParse(input)
  if (!parsed.success) return { ok: false, error: 'validation' }
  const [channel] = await whatsappChannels(clientId, channelId)
  if (!channel) return { ok: false, error: 'forbidden' }

  const admin = createAdminClient()
  const existing = await listTemplates({ supabase: admin, channelId })
  if (existing.kind !== 'ok') return { ok: false, error: 'createFailed' }
  if (existing.templates.some((t) => t.name === parsed.data.name && t.language === parsed.data.language)) {
    return { ok: false, error: 'nameTaken' }
  }

  const outcome = await createTemplate({ supabase: admin, channelId, template: parsed.data })
  if (outcome.kind !== 'created') return { ok: false, error: 'createFailed' }
  revalidatePath(TEMPLATES_PATH, 'page')
  // Meta answers PENDING almost always; whatever it says is what the screen shows
  return { ok: true, status: outcome.status === undefined ? 'pending' : templateStatus(outcome.status) }
}
