'use server'

import { loadBotSettings, runBot, type BotClient } from '@/lib/ai/bot'
import {
  confirmsItself,
  replyLanguage,
  requestedDayKey,
  resolveAppointment,
  resolveDay,
  withoutTime,
  type AppointmentResolution,
  type BookingOutcome,
} from '@/lib/ai/appointment'
import { branchInMessage, loadBookingBranches } from '@/lib/ai/branches'
import { withEvidence } from '@/lib/ai/evidence'
import { composeReply } from '@/lib/ai/compose'
import { canManage, getSession, isImpersonating } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkClientLimit, guardLimit } from '@/lib/subscription-limits'
import { botSettingsSchema, effectiveBookingMode, type BotSettingsInput } from '@/lib/types/bot-settings'
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
 * in-memory conversation. Nothing is stored, but each reply is a real AI
 * call, so it's metered like the widget: refused without an active
 * subscription or past the monthly messages, and counted when it succeeds.
 * `settingsOverride` previews unsaved bot settings; only admins, who could
 * save those settings anyway, may pass it.
 */
export async function testBot(
  clientId: string,
  messages: PlaygroundMessage[],
  settingsOverride?: BotSettingsInput
): Promise<PlaygroundResult> {
  if (await isImpersonating()) return { ok: false, error: 'impersonating' }
  const { supabase, profile } = await getSession()
  if (!profile) return { ok: false, error: 'unauthorized' }
  // Testing the bot is part of configuring it: client admins and up
  if (!canManage(profile)) return { ok: false, error: 'forbidden' }
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

  // Same gate as the widget, before any AI call
  const blocked = await guardLimit(checkClientLimit(supabase, clientId, 'messages'))
  if (blocked) return { ok: false, error: blocked }

  let override: BotSettingsInput | undefined
  if (settingsOverride !== undefined) {
    const parsed = botSettingsSchema.safeParse(settingsOverride)
    if (!parsed.success) return { ok: false, error: 'validation' }
    override = parsed.data
  }

  try {
    const settings = override ?? (await loadBotSettings(supabase, clientId))
    const branches = await loadBookingBranches(supabase, clientId).catch((error) => {
      console.error('[playground] reading the branches failed', error)
      return []
    })
    const { reply: template, appointment, otherAnswer, branch: reportedBranch } = await runBot({
      supabase,
      clientId,
      client,
      settings,
      history: messages.map((m) => ({ role: m.role, content: m.content })),
      // Unsaved settings: the bot settings page's live preview
      operation: override ? 'bot_preview' : 'playground',
      branches,
    })
    // Nothing is booked from a test chat: the reply shows what a visitor
    // would get if the requested time were recorded
    const visitorMessages = messages.filter((m) => m.role === 'user').map((m) => m.content)
    // Only what the latest message shows a trace of, as the widget takes it.
    // No draft here: a test chat keeps nothing between messages.
    const evidenced = appointment ? withEvidence(appointment, visitorMessages.at(-1) ?? '').request : null
    // The business's booking shape, as the widget applies it (runBot already
    // drops any booking with none)
    const mode = effectiveBookingMode(settings)
    // The branch, as the widget would hold it: the only one, or the latest a
    // visitor message named (a test chat keeps no draft to hold it in)
    const several = branches.length > 1
    const branch = several
      ? ([...visitorMessages]
          .reverse()
          .map((text, i) => branchInMessage(branches, text, i === 0 ? reportedBranch : null))
          .find(Boolean) ?? null)
      : (branches[0] ?? null)
    const hours = branch?.schedule ?? null
    const resolved: BookingOutcome | AppointmentResolution = !evidenced
      ? { status: 'none' }
      : several && !branch
        ? { status: 'ask_branch', day: requestedDayKey(evidenced), branches: branches.map((b) => b.name) }
        : mode === 'day_only'
          ? resolveDay(withoutTime(evidenced), { businessHours: hours })
          : resolveAppointment(evidenced, { businessHours: hours, hourFromPartOfDay: false })
    // Nothing is saved from a test chat either: a reply that states what is
    // on record says there is nothing, as it would to a visitor with no lead
    const reply = composeReply({
      template,
      events: { name: 'none', phone: 'none' },
      record: { name: null, phone: null },
      visitorMessages,
      language: replyLanguage(settings.language, visitorMessages.at(-1) ?? ''),
      appointmentDecided: Boolean(appointment),
      otherAnswer,
      rules: { mode, nameStrictness: settings.name_strictness, branch: several ? (branch?.name ?? null) : null },
      outcome:
      resolved.status === 'resolved'
        ? {
            status: 'booked',
            at: resolved.at,
            // As the widget would: only a time code checked against opening hours is confirmed
            confirmed: confirmsItself(settings.auto_confirm_appointments, resolved.validated),
            changed: true,
            validated: resolved.validated,
          }
        : resolved,
    })
    // The reply reads as a booking: the caller has to say it's a rehearsal
    const simulated = resolved.status === 'resolved' ? { simulatedAppointment: resolved.at } : {}
    // Counted like a widget reply. consume_client_message is service-role
    // only; access to this client was checked above.
    const { error: usageError } = await createAdminClient().rpc('consume_client_message', { p_client_id: clientId })
    if (usageError) console.error('[playground] counting the message failed', usageError)
    return { ok: true, reply, ...simulated }
  } catch (error) {
    console.error('[playground] bot failed', error)
    return { ok: false, error: 'aiUnavailable' }
  }
}
