'use server'

import { revalidatePath } from 'next/cache'
import { canManage, getSession } from '@/lib/auth/session'
import { loadBotSettings } from '@/lib/ai/bot'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  botSettingsSchema,
  type BotSettingsActionResult,
  type BotSettingsInput,
} from '@/lib/types/bot-settings'
import { BOT_PRESET_NAMES, BOT_PRESETS, type BotPresetName } from '@/lib/constants/bot-presets'

const CLIENT_PAGES = '/[locale]/dashboard/clients/[clientId]'

async function clientVisible(supabase: Awaited<ReturnType<typeof getSession>>['supabase'], clientId: string) {
  const { data } = await supabase.from('clients').select('id').eq('id', clientId).maybeSingle()
  return !!data
}

/** The client's settings, or the defaults if none are saved; null without access. */
export async function getBotSettings(clientId: string): Promise<BotSettingsInput | null> {
  if (!UUID_PATTERN.test(clientId)) return null
  const { supabase, profile } = await getSession()
  // Bot settings are for client admins and up (RLS agrees)
  if (!profile || !canManage(profile)) return null
  // get_bot_settings falls back to defaults, so check access explicitly
  if (!(await clientVisible(supabase, clientId))) return null
  return loadBotSettings(supabase, clientId)
}

async function saveSettings(clientId: string, settings: BotSettingsInput): Promise<BotSettingsActionResult> {
  const { supabase } = await getSession()
  // Upsert: rows are created with each client, but older data may lack one.
  // RLS limits writes to super/org/client admins of this client.
  const { data, error } = await supabase
    .from('bot_settings')
    .upsert({ client_id: clientId, ...settings }, { onConflict: 'client_id' })
    .select('client_id')

  if (error) {
    if (error.code === '42501') return { ok: false, error: 'forbidden' }
    console.error('[bot-settings] save', error)
    return { ok: false, error: 'unknown' }
  }
  if (!data || data.length === 0) return { ok: false, error: 'notFound' }

  revalidatePath(`${CLIENT_PAGES}/bot-settings`, 'page')
  revalidatePath(`${CLIENT_PAGES}/playground`, 'page')
  return { ok: true }
}

export async function updateBotSettings(
  clientId: string,
  settings: BotSettingsInput
): Promise<BotSettingsActionResult> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(clientId)) return { ok: false, error: 'notFound' }

  const parsed = botSettingsSchema.safeParse(settings)
  if (!parsed.success) return { ok: false, error: 'validation' }
  if (!(await clientVisible(supabase, clientId))) return { ok: false, error: 'notFound' }

  return saveSettings(clientId, parsed.data)
}

/** Saves a preset's persona, messages and behaviour; keeps language and hours. */
export async function resetToPreset(
  clientId: string,
  presetName: BotPresetName
): Promise<BotSettingsActionResult> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
  if (!UUID_PATTERN.test(clientId)) return { ok: false, error: 'notFound' }
  if (!(BOT_PRESET_NAMES as readonly string[]).includes(presetName)) {
    return { ok: false, error: 'validation' }
  }
  if (!(await clientVisible(supabase, clientId))) return { ok: false, error: 'notFound' }

  const current = await loadBotSettings(supabase, clientId)
  return saveSettings(clientId, { ...current, ...BOT_PRESETS[presetName] })
}
