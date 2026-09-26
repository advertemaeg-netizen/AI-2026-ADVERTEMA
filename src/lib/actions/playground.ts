'use server'

import { loadBotSettings, runBot, type BotClient } from '@/lib/ai/bot'
import { canManage, getSession } from '@/lib/auth/session'
import { botSettingsSchema, type BotSettingsInput } from '@/lib/types/bot-settings'
import { UUID_PATTERN } from '@/lib/types/clients'
import {
  PLAYGROUND_MAX_MESSAGE_LENGTH,
  PLAYGROUND_MAX_MESSAGES,
  type PlaygroundMessage,
  type PlaygroundResult,
} from '@/lib/types/playground'

// Loose per-user guard against runaway loops, not a billing control.
// Per server instance, like the webhook limiter.
const RATE_LIMIT = { windowMs: 60_000, max: 30 }
const hits = new Map<string, { count: number; resetAt: number }>()

function rateLimited(key: string) {
  const now = Date.now()
  const entry = hits.get(key)
  if (!entry || entry.resetAt <= now) {
    if (hits.size > 10_000) hits.clear()
    hits.set(key, { count: 1, resetAt: now + RATE_LIMIT.windowMs })
    return false
  }
  entry.count += 1
  return entry.count > RATE_LIMIT.max
}

function isValidHistory(messages: unknown): messages is PlaygroundMessage[] {
  return (
    Array.isArray(messages) &&
    messages.length > 0 &&
    messages.length <= PLAYGROUND_MAX_MESSAGES &&
    messages.every(
      (m) =>
        m &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0 &&
        m.content.length <= PLAYGROUND_MAX_MESSAGE_LENGTH
    ) &&
    messages[messages.length - 1].role === 'user'
  )
}

/**
 * Runs the client's real assistant (knowledge base + bot settings) on an
 * in-memory conversation. Nothing is stored and usage isn't metered.
 * `settingsOverride` previews unsaved bot settings; only admins, who could
 * save those settings anyway, may pass it.
 */
export async function testBot(
  clientId: string,
  messages: PlaygroundMessage[],
  includeDebug = false,
  settingsOverride?: BotSettingsInput
): Promise<PlaygroundResult> {
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  if (!UUID_PATTERN.test(clientId)) return { ok: false, error: 'notFound' }
  if (!isValidHistory(messages)) return { ok: false, error: 'validation' }
  if (rateLimited(profile.id)) return { ok: false, error: 'rateLimited' }

  // RLS: any role with access to this client may test it
  const { data: client } = await supabase
    .from('clients')
    .select('name, industry, description')
    .eq('id', clientId)
    .maybeSingle<BotClient>()
  if (!client) return { ok: false, error: 'notFound' }

  let override: BotSettingsInput | undefined
  if (settingsOverride !== undefined) {
    if (!canManage(profile)) return { ok: false, error: 'validation' }
    const parsed = botSettingsSchema.safeParse(settingsOverride)
    if (!parsed.success) return { ok: false, error: 'validation' }
    override = parsed.data
  }

  try {
    const settings = override ?? (await loadBotSettings(supabase, clientId))
    const { reply, debug } = await runBot({
      supabase,
      clientId,
      client,
      settings,
      history: messages.map((m) => ({ role: m.role, content: m.content })),
    })
    return includeDebug ? { ok: true, reply, debug } : { ok: true, reply }
  } catch (error) {
    console.error('[playground] bot failed', error)
    return { ok: false, error: 'aiUnavailable' }
  }
}
