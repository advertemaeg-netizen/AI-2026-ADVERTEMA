'use server'

import type { BotClient } from '@/lib/ai/bot'
import { leadsInMemory, type BookableLead } from '@/lib/ai/booking'
import { replyToMessage, type HistoryRow, type ReplyStore } from '@/lib/ai/reply'
import { canManage, getSession, isImpersonating } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { checkClientLimit, guardLimit } from '@/lib/subscription-limits'
import { botSettingsSchema, type BotSettingsInput } from '@/lib/types/bot-settings'
import { UUID_PATTERN } from '@/lib/types/clients'
import { CLOSED_LEAD_STATUSES } from '@/lib/types/leads'
import {
  PLAYGROUND_MAX_MESSAGE_LENGTH,
  PLAYGROUND_MAX_MESSAGES,
  playgroundStateSchema,
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
        m.content.length <= PLAYGROUND_MAX_MESSAGE_LENGTH &&
        (m.metadata === undefined || m.metadata === null || (typeof m.metadata === 'object' && !Array.isArray(m.metadata)))
    ) &&
    messages[messages.length - 1].role === 'user'
  )
}

/**
 * THE TEST CHAT'S ROWS, IN MEMORY. The pipeline reads its history from the
 * chat the browser sent, replies' traces included, and writes its reply row
 * here, where the caller picks it up; the lead rows have their own in-memory
 * sink (leadsInMemory). Nothing reaches the database except what a widget
 * reply also costs: the message count below, and ai_usage inside the model
 * call. A test chat is never marked for a person and never analysed for a
 * lead, so no analysis tokens are spent on it.
 */
function playgroundStore(clientId: string, messages: PlaygroundMessage[], leads: ReplyStore['leads']) {
  const store: ReplyStore & { written: { content: string; metadata: Record<string, unknown> } | null } = {
    written: null,
    leads,
    async history(limit) {
      // Newest first, as the database answers
      return [...messages]
        .reverse()
        .slice(0, limit)
        .map((m): HistoryRow => ({ role: m.role, content: m.content, metadata: m.metadata ?? null }))
    },
    async insertReply(row) {
      store.written = row
      return { error: null }
    },
    async markForPerson() {},
    async countMessage() {
      // Counted like a widget reply. consume_client_message is service-role
      // only; access to this client was checked before the pipeline ran.
      const { error } = await createAdminClient().rpc('consume_client_message', { p_client_id: clientId })
      return { error }
    },
    scheduleLeadDetection() {},
  }
  return store
}

const openLead = (rows: BookableLead[]) => rows.find((lead) => !CLOSED_LEAD_STATUSES.includes(lead.status)) ?? null

/**
 * Runs the client's real assistant on a conversation the browser holds: THE
 * SAME PIPELINE AS THE WIDGET (replyToMessage), with the same knowledge base
 * and bot settings. Nothing is stored. The rows the pipeline would have
 * written (the lead, each reply's trace) come back in `state` and `metadata`,
 * and the browser sends them with the next message, so a test of several
 * messages runs as a visitor's chat does. Each reply is a real AI call, so
 * it's metered like the widget: refused without an active subscription or
 * past the monthly messages, and counted when it succeeds. `settingsOverride`
 * previews unsaved bot settings; only admins, who could save those settings
 * anyway, may pass it.
 */
export async function testBot(
  clientId: string,
  messages: PlaygroundMessage[],
  settingsOverride?: BotSettingsInput,
  state?: unknown
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

  // The lead rows the chat has written so far, as the browser carried them
  let leadRows: BookableLead[] = []
  if (state !== undefined) {
    const parsed = playgroundStateSchema.safeParse(state)
    if (!parsed.success) return { ok: false, error: 'validation' }
    // The shape is the sink's own output, checked loosely above
    leadRows = parsed.data.leads as BookableLead[]
  }

  try {
    const leads = leadsInMemory(leadRows)
    const before = openLead(leads.rows)?.appointment_at ?? null
    const store = playgroundStore(clientId, messages, leads)
    const outcome = await replyToMessage({
      supabase,
      channel: { client_id: clientId, clients: client },
      conversationId: null,
      autoReply: true,
      userMessage: { id: null },
      message: messages[messages.length - 1].content,
      store,
      source: 'playground',
      // Unsaved settings: the bot settings page's live preview
      settings: override,
      operation: override ? 'bot_preview' : 'playground',
    })
    switch (outcome.kind) {
      case 'unavailable':
        return { ok: false, error: 'aiUnavailable' }
      case 'fallback':
        // The admin is told the cause, as before the pipeline, not shown the visitor's fallback text
        return {
          ok: false,
          error:
            outcome.fallback === 'ai_unavailable' ? 'aiUnavailable' : outcome.reason === 'inactive' ? 'subscriptionInactive' : 'limitReached',
        }
      case 'handoff':
        // autoReply is true above: nothing hands a test chat to a person
        return { ok: false, error: 'unknown' }
      case 'reply': {
        const afterwards = openLead(leads.rows)?.appointment_at ?? null
        return {
          ok: true,
          reply: outcome.reply,
          metadata: store.written?.metadata ?? null,
          state: { leads: leads.rows },
          // The reply reads as a booking: the caller has to say it's a rehearsal
          ...(afterwards !== null && afterwards !== before ? { simulatedAppointment: afterwards } : {}),
        }
      }
    }
  } catch (error) {
    console.error('[playground] bot failed', error)
    return { ok: false, error: 'aiUnavailable' }
  }
}
