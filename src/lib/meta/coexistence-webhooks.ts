import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import { HISTORY_DECLINED_CODE } from '@/lib/meta/coexistence'
import { conversationFor, placeholderFor, type InboundChannel } from '@/lib/meta/inbound'
import { claimMessages, completeMessages } from '@/lib/meta/processed'
import { WHATSAPP_PLACEHOLDER_AR } from '@/lib/meta/whatsapp-notices-ar'

/**
 * THE FOUR COEXISTENCE WEBHOOK FIELDS (2026-11-15). Parsed exactly as Meta's
 * webhook reference documents them, handled only while
 * META_WHATSAPP_COEXISTENCE is on (the route checks before calling anything
 * here; tests/meta/coexistence-off.test.ts holds it), and only for a channel
 * connected as coexistence.
 *
 *   smb_message_echoes   the business sent from its own phone (or edited,
 *                        or deleted, a message there): an 'agent' row,
 *                        sent_from 'phone'. A person's reply, like one from
 *                        the dashboard: it hands the conversation to people,
 *                        and insert_bot_reply never answers over it.
 *   smb_app_state_sync   a contact added, edited or removed: names only.
 *   history              the one-shot import: each chunk stored raw first,
 *                        then imported as rows marked `imported`, which
 *                        nothing live ever reads. NEVER A REPLY: imported
 *                        rows never reach the pipeline, and the parser in
 *                        webhook.ts reads `messages` only.
 *   account_update       ACCOUNT_OFFBOARDED / ACCOUNT_RECONNECTED: a device
 *                        change pauses a coexistence number (Meta: "Pause any
 *                        pending Cloud API message sends") until it is back.
 *
 * NEVER LOGGED: any message text, any person's number or user id, any
 * contact's name. Logged: our ids, Meta's message ids, counts and states.
 */

type Json = Record<string, unknown>
const isObject = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value)
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isObject) : [])
const text = (value: unknown) => (typeof value === 'string' ? value : typeof value === 'number' ? String(value) : undefined)
const LOG = '[whatsapp/coexistence]'

export type CoexistenceChannel = { channelId: string; channel: InboundChannel }

/** The changes of one field in a WhatsApp delivery, each with the number it arrived on */
function changesOf(payload: unknown, field: string): { businessId: string; value: Json }[] {
  const body = isObject(payload) ? payload : {}
  if (text(body.object) !== 'whatsapp_business_account') return []
  const out: { businessId: string; value: Json }[] = []
  for (const entry of list(body.entry)) {
    for (const change of list(entry.changes)) {
      if (change.field !== field) continue
      const value = isObject(change.value) ? change.value : {}
      const metadata = isObject(value.metadata) ? value.metadata : {}
      const businessId = text(metadata.phone_number_id)
      if (businessId) out.push({ businessId, value })
    }
  }
  return out
}

// ---------------------------------------------------------------------------
// smb_message_echoes
// ---------------------------------------------------------------------------

export type PhoneEcho = {
  businessId: string
  messageId: string
  /** The person the business wrote to: their number, or their user id when they have a username (Meta omits the number then) */
  to: string
  type: string
  text?: string
  /** edit and revoke: the message they change */
  originalId?: string
}

export function parsePhoneEchoes(payload: unknown): PhoneEcho[] {
  const out: PhoneEcho[] = []
  for (const { businessId, value } of changesOf(payload, 'smb_message_echoes')) {
    for (const echo of list(value.message_echoes)) {
      const messageId = text(echo.id)
      const to = text(echo.to) ?? text(echo.to_user_id)
      const type = text(echo.type)
      if (!messageId || !to || !type) continue
      if (type === 'revoke') {
        const original = isObject(echo.revoke) ? text(echo.revoke.original_message_id) : undefined
        out.push({ businessId, messageId, to, type, ...(original ? { originalId: original } : {}) })
        continue
      }
      if (type === 'edit') {
        const edit = isObject(echo.edit) ? echo.edit : {}
        const original = text(edit.original_message_id)
        const message = isObject(edit.message) ? edit.message : {}
        const edited = isObject(message.text) ? text(message.text.body) : undefined
        out.push({ businessId, messageId, to, type, ...(original ? { originalId: original } : {}), ...(edited !== undefined ? { text: edited } : {}) })
        continue
      }
      const body = isObject(echo.text) ? text(echo.text.body) : undefined
      const caption = isObject(echo[type]) ? text((echo[type] as Json).caption) : undefined
      const words = body ?? caption
      out.push({ businessId, messageId, to, type, ...(words !== undefined ? { text: words } : {}) })
    }
  }
  return out
}

export type EchoDisposition = 'stored' | 'edited' | 'revoked' | 'original_missing' | 'duplicate' | 'not_coexistence' | 'failed'

/** The business's phone: one agent row per message it sent, claimed so a retry does nothing */
export async function handlePhoneEchoes(supabase: SupabaseClient, payload: unknown, channels: Record<string, CoexistenceChannel>): Promise<Record<string, EchoDisposition>> {
  const out: Record<string, EchoDisposition> = {}
  const echoes = parsePhoneEchoes(payload).filter((echo) => {
    const mapped = channels[echo.businessId]
    if (mapped?.channel.whatsapp_mode === 'coexistence') return true
    out[echo.messageId] = 'not_coexistence'
    return false
  })
  const fresh = await claimMessages(
    supabase,
    echoes.map((echo) => ({ messageId: echo.messageId, channelId: channels[echo.businessId].channelId }))
  )
  for (const echo of echoes) {
    if (!fresh.has(echo.messageId)) {
      out[echo.messageId] = 'duplicate'
      continue
    }
    const { channel, channelId } = channels[echo.businessId]
    try {
      const { conversationId } = await conversationFor(supabase, channel, echo.to)
      if (echo.type === 'revoke' || echo.type === 'edit') {
        out[echo.messageId] = await changePhoneMessage(supabase, conversationId, echo)
        continue
      }
      const words = echo.text?.trim()
      const { error } = await supabase.from('messages').insert({
        conversation_id: conversationId,
        role: 'agent',
        sent_from: 'phone',
        content: words || WHATSAPP_PLACEHOLDER_AR[placeholderFor(echo.type)],
        metadata: { transport: 'whatsapp', whatsapp_type: echo.type, messageId: echo.messageId, ...(words ? {} : { placeholder: true }) },
      })
      if (error) throw error
      out[echo.messageId] = 'stored'
      console.info(`${LOG} a message from the business's phone`, { channelId, conversationId, messageId: echo.messageId, type: echo.type })
    } catch (error) {
      out[echo.messageId] = 'failed'
      console.error(`${LOG} storing a phone message failed`, { channelId, messageId: echo.messageId, code: (error as { code?: string })?.code ?? null })
    }
  }
  await completeMessages(supabase, echoes.map((echo) => echo.messageId))
  return out
}

/**
 * An edit or a deletion made on the phone, applied to the row it changes. A
 * deleted message keeps its row, marked (the inbox says it was deleted on the
 * phone, never shows the text again): the owner's call to blank or keep it.
 */
async function changePhoneMessage(supabase: SupabaseClient, conversationId: string, echo: PhoneEcho): Promise<EchoDisposition> {
  if (!echo.originalId) return 'original_missing'
  const { data: original, error } = await supabase
    .from('messages')
    .select('id, metadata')
    .eq('conversation_id', conversationId)
    .eq('sent_from', 'phone')
    .eq('metadata->>messageId', echo.originalId)
    .maybeSingle<{ id: string; metadata: Json | null }>()
  if (error) throw error
  if (!original) return 'original_missing'
  const now = new Date().toISOString()
  const update =
    echo.type === 'revoke'
      ? { metadata: { ...(original.metadata ?? {}), revoked_at: now } }
      : { ...(echo.text?.trim() ? { content: echo.text.trim() } : {}), metadata: { ...(original.metadata ?? {}), edited_at: now } }
  const { error: updateError } = await supabase.from('messages').update(update).eq('id', original.id)
  if (updateError) throw updateError
  return echo.type === 'revoke' ? 'revoked' : 'edited'
}

// ---------------------------------------------------------------------------
// smb_app_state_sync
// ---------------------------------------------------------------------------

export type ContactChange = {
  businessId: string
  action: 'add' | 'remove'
  phoneNumber?: string
  userId?: string
  fullName?: string
  firstName?: string
}

export function parseContactChanges(payload: unknown): ContactChange[] {
  const out: ContactChange[] = []
  for (const { businessId, value } of changesOf(payload, 'smb_app_state_sync')) {
    for (const item of list(value.state_sync)) {
      if (text(item.type) !== 'contact') continue
      const action = text(item.action)
      if (action !== 'add' && action !== 'remove') continue
      const contact = isObject(item.contact) ? item.contact : {}
      const phoneNumber = text(contact.phone_number)
      const userId = text(contact.user_id)
      if (!phoneNumber && !userId) continue
      const fullName = text(contact.full_name)?.trim()
      const firstName = text(contact.first_name)?.trim()
      out.push({
        businessId,
        action,
        ...(phoneNumber ? { phoneNumber } : {}),
        ...(userId ? { userId } : {}),
        ...(fullName ? { fullName } : {}),
        ...(firstName ? { firstName } : {}),
      })
    }
  }
  return out
}

/** A business's contacts: kept to name its conversations; a removed one deleted. The first marks the contacts import done */
export async function handleContactChanges(supabase: SupabaseClient, payload: unknown, channels: Record<string, CoexistenceChannel>): Promise<{ added: number; removed: number; skipped: number }> {
  const counts = { added: 0, removed: 0, skipped: 0 }
  const touched = new Set<string>()
  for (const change of parseContactChanges(payload)) {
    const mapped = channels[change.businessId]
    if (mapped?.channel.whatsapp_mode !== 'coexistence') {
      counts.skipped += 1
      continue
    }
    const key = change.phoneNumber ? { column: 'phone_number', value: change.phoneNumber } : { column: 'user_id', value: change.userId! }
    let query = supabase.from('whatsapp_contacts').select('id').eq('channel_id', mapped.channelId).eq(key.column, key.value)
    if (!change.phoneNumber) query = query.is('phone_number', null)
    const { data: existing, error } = await query.maybeSingle<{ id: string }>()
    if (error) throw error
    if (change.action === 'remove') {
      if (existing) {
        const { error: deleteError } = await supabase.from('whatsapp_contacts').delete().eq('id', existing.id)
        if (deleteError) throw deleteError
      }
      counts.removed += 1
    } else {
      const row = {
        channel_id: mapped.channelId,
        phone_number: change.phoneNumber ?? null,
        user_id: change.userId ?? null,
        full_name: change.fullName ?? null,
        first_name: change.firstName ?? null,
        updated_at: new Date().toISOString(),
      }
      const { error: writeError } = existing
        ? await supabase.from('whatsapp_contacts').update(row).eq('id', existing.id)
        : await supabase.from('whatsapp_contacts').insert(row)
      if (writeError) throw writeError
      // A conversation with no name takes the business's own name for the person
      const name = change.fullName ?? change.firstName
      if (name && change.phoneNumber) {
        const { error: nameError } = await supabase
          .from('conversations')
          .update({ contact_name: name.slice(0, 100) })
          .eq('channel_id', mapped.channelId)
          .eq('contact_identifier', change.phoneNumber)
          .is('contact_name', null)
        if (nameError) throw nameError
      }
      counts.added += 1
    }
    touched.add(mapped.channelId)
  }
  for (const channelId of touched) {
    await supabase.from('channels').update({ contacts_sync: 'complete' }).eq('id', channelId).eq('contacts_sync', 'requested')
  }
  if (counts.added + counts.removed > 0) console.info(`${LOG} contacts`, { channels: [...touched], ...counts })
  return counts
}

// ---------------------------------------------------------------------------
// history
// ---------------------------------------------------------------------------

export type HistoryMessage = {
  messageId: string
  from: string
  type: string
  text?: string
  sentAt: string
  status?: string
}
export type HistoryThread = { contact: string; userId?: string; messages: HistoryMessage[] }
export type HistoryChunk =
  | { kind: 'declined'; businessId: string; code: number }
  | { kind: 'chunk'; businessId: string; phase: number | null; chunkOrder: number | null; progress: number | null; threads: HistoryThread[]; raw: Json }
  /** A later media webhook: the media id of a message imported as a placeholder */
  | { kind: 'media'; businessId: string; messageId: string; mediaId: string; type: string }

const seconds = (value: unknown) => {
  const n = Number(text(value))
  return Number.isFinite(n) && n > 0 ? new Date(n * 1000).toISOString() : null
}
const int = (value: unknown) => {
  const n = Number(value)
  return Number.isInteger(n) ? n : null
}

export function parseHistory(payload: unknown): HistoryChunk[] {
  const out: HistoryChunk[] = []
  for (const { businessId, value } of changesOf(payload, 'history')) {
    for (const item of list(value.history)) {
      const errors = list(item.errors)
      if (errors.length > 0) {
        const code = errors.map((e) => int(e.code)).find((c) => c !== null) ?? 0
        out.push({ kind: 'declined', businessId, code })
        continue
      }
      const metadata = isObject(item.metadata) ? item.metadata : {}
      const threads: HistoryThread[] = []
      for (const thread of list(item.threads)) {
        const context = isObject(thread.context) ? thread.context : {}
        const contact = text(context.wa_id) ?? text(thread.id) ?? text(context.user_id)
        if (!contact) continue
        const messages: HistoryMessage[] = []
        for (const message of list(thread.messages)) {
          const messageId = text(message.id)
          const from = text(message.from) ?? text(message.from_user_id)
          const type = text(message.type)
          const sentAt = seconds(message.timestamp)
          if (!messageId || !from || !type || !sentAt) continue
          const body = isObject(message.text) ? text(message.text.body) : undefined
          const status = isObject(message.history_context) ? text(message.history_context.status) : undefined
          messages.push({ messageId, from, type, sentAt, ...(body !== undefined ? { text: body } : {}), ...(status ? { status } : {}) })
        }
        const userId = text(context.user_id)
        threads.push({ contact, ...(userId ? { userId } : {}), messages })
      }
      out.push({ kind: 'chunk', businessId, phase: int(metadata.phase), chunkOrder: int(metadata.chunk_order), progress: int(metadata.progress), threads, raw: item })
    }
    for (const message of list(value.messages)) {
      const messageId = text(message.id)
      const type = text(message.type)
      const media = type && isObject(message[type]) ? text((message[type] as Json).id) : undefined
      if (messageId && type && media) out.push({ kind: 'media', businessId, messageId, mediaId: media, type })
    }
  }
  return out
}

export type HistoryDisposition = { declined: number; chunks: number; imported: number; media: number; skipped: number }

/**
 * The one-shot import. Each chunk is stored raw before it is read (one can
 * hold thousands of messages), then imported: each thread's conversation,
 * each message an `imported` row with Meta's time, once (a resent chunk adds
 * nothing). Progress only moves forward; 100 is the only completion signal
 * (Meta's two pages disagree on what `phase` means). A declined history
 * (error 2593109) is final: Meta says the choice cannot be changed.
 */
export async function handleHistory(supabase: SupabaseClient, payload: unknown, channels: Record<string, CoexistenceChannel>): Promise<HistoryDisposition> {
  const out: HistoryDisposition = { declined: 0, chunks: 0, imported: 0, media: 0, skipped: 0 }
  for (const chunk of parseHistory(payload)) {
    const mapped = channels[chunk.businessId]
    if (mapped?.channel.whatsapp_mode !== 'coexistence') {
      out.skipped += 1
      continue
    }
    const { channelId, channel } = mapped
    if (chunk.kind === 'declined') {
      await supabase.from('channels').update({ history_sync: chunk.code === HISTORY_DECLINED_CODE ? 'declined' : 'request_failed' }).eq('id', channelId)
      console.warn(`${LOG} history not shared`, { channelId, code: chunk.code })
      out.declined += 1
      continue
    }
    if (chunk.kind === 'media') {
      // The media id onto the row imported as a placeholder, its other metadata kept
      const { data: rows, error } = await supabase
        .from('messages')
        .select('id, metadata, conversations!inner(channel_id)')
        .eq('imported', true)
        .eq('conversations.channel_id', channelId)
        .eq('metadata->>wamid', chunk.messageId)
        .returns<{ id: string; metadata: Json | null }[]>()
      if (error) throw error
      for (const row of rows) {
        const { error: updateError } = await supabase.from('messages').update({ metadata: { ...(row.metadata ?? {}), media_id: chunk.mediaId } }).eq('id', row.id)
        if (updateError) throw updateError
      }
      out.media += rows.length
      continue
    }
    const { data: stored, error: storeError } = await supabase
      .from('whatsapp_history_chunks')
      .insert({ channel_id: channelId, phase: chunk.phase, chunk_order: chunk.chunkOrder, progress: chunk.progress, payload: chunk.raw })
      .select('id')
      .single<{ id: string }>()
    if (storeError) throw storeError
    out.chunks += 1

    const imported = await importThreads(supabase, channel, chunk.threads)
    out.imported += imported

    // The chunk is ours now; its raw copy goes (message content is kept once, as rows)
    await supabase.from('whatsapp_history_chunks').delete().eq('id', stored.id)
    await recordProgress(supabase, channelId, chunk.progress, imported)
  }
  if (out.chunks + out.declined + out.media > 0) console.info(`${LOG} history`, out)
  return out
}

/** The threads of one chunk as imported rows; how many were new */
async function importThreads(supabase: SupabaseClient, channel: InboundChannel, threads: HistoryThread[]): Promise<number> {
  let imported = 0
  for (const thread of threads) {
    if (thread.messages.length === 0) continue
    const { conversationId } = await conversationFor(supabase, channel, thread.contact)
    const ids = thread.messages.map((m) => m.messageId)
    const { data: present, error } = await supabase
      .from('messages')
      .select('wamid:metadata->>wamid')
      .eq('conversation_id', conversationId)
      .eq('imported', true)
      .in('metadata->>wamid', ids)
      .returns<{ wamid: string }[]>()
    if (error) throw error
    const known = new Set(present.map((row) => row.wamid))
    const rows = thread.messages
      .filter((m) => !known.has(m.messageId))
      .map((m) => {
        // From the person (their number, the thread's) or from the business, from its phone
        const fromBusiness = m.from !== thread.contact && m.from !== thread.userId
        const words = m.text?.trim()
        return {
          conversation_id: conversationId,
          role: fromBusiness ? 'agent' : 'user',
          ...(fromBusiness ? { sent_from: 'phone' } : {}),
          imported: true,
          sent_at: m.sentAt,
          content: words || WHATSAPP_PLACEHOLDER_AR[placeholderFor(m.type)],
          metadata: { transport: 'whatsapp', whatsapp_type: m.type, wamid: m.messageId, ...(m.status ? { history_status: m.status } : {}), ...(words ? {} : { placeholder: true }) },
        }
      })
    if (rows.length === 0) continue
    const { error: insertError } = await supabase.from('messages').insert(rows)
    if (insertError) throw insertError
    imported += rows.length
    // A conversation the import opened starts when its first message was sent, not today
    const first = thread.messages.reduce((earliest, m) => (m.sentAt < earliest ? m.sentAt : earliest), thread.messages[0].sentAt)
    await supabase.from('conversations').update({ created_at: first }).eq('id', conversationId).gt('created_at', first)
  }
  return imported
}

async function recordProgress(supabase: SupabaseClient, channelId: string, progress: number | null, imported: number) {
  const { data: row, error } = await supabase
    .from('channels')
    .select('history_sync, history_sync_progress, history_imported')
    .eq('id', channelId)
    .single<{ history_sync: string | null; history_sync_progress: number | null; history_imported: number }>()
  if (error) throw error
  // A declined or completed import is not reopened by a late chunk
  const settled = row.history_sync === 'declined' || row.history_sync === 'complete'
  const reached = Math.max(row.history_sync_progress ?? 0, Math.min(100, Math.max(0, progress ?? 0)))
  const { error: updateError } = await supabase
    .from('channels')
    .update({
      history_imported: row.history_imported + imported,
      history_sync_progress: reached,
      ...(settled ? {} : { history_sync: reached >= 100 ? 'complete' : 'receiving' }),
    })
    .eq('id', channelId)
  if (updateError) throw updateError
}

// ---------------------------------------------------------------------------
// account_update: a coexistence number offboarded and back
// ---------------------------------------------------------------------------

export function parseOffboarding(payload: unknown): { wabaId: string; event: 'ACCOUNT_OFFBOARDED' | 'ACCOUNT_RECONNECTED' }[] {
  const body = isObject(payload) ? payload : {}
  if (text(body.object) !== 'whatsapp_business_account') return []
  const out: { wabaId: string; event: 'ACCOUNT_OFFBOARDED' | 'ACCOUNT_RECONNECTED' }[] = []
  for (const entry of list(body.entry)) {
    // For these two, Meta's entry.id is the Messaging account (the WABA)
    const wabaId = text(entry.id)
    if (!wabaId) continue
    for (const change of list(entry.changes)) {
      if (change.field !== 'account_update') continue
      const event = isObject(change.value) ? text(change.value.event) : undefined
      if (event === 'ACCOUNT_OFFBOARDED' || event === 'ACCOUNT_RECONNECTED') out.push({ wabaId, event })
    }
  }
  return out
}

/** Pauses (or resumes) a WABA's coexistence numbers. Never disconnects, never deletes, never tells Meta anything */
export async function handleOffboarding(supabase: SupabaseClient, payload: unknown): Promise<Record<string, number>> {
  const out: Record<string, number> = {}
  for (const { wabaId, event } of parseOffboarding(payload)) {
    const { data: secrets, error } = await supabase.from('channel_secrets').select('channel_id').eq('waba_id', wabaId).returns<{ channel_id: string }[]>()
    if (error) throw error
    const ids = secrets.map((s) => s.channel_id)
    if (ids.length === 0) {
      out[`${event}:${wabaId}`] = 0
      continue
    }
    const { data: changed, error: updateError } = await supabase
      .from('channels')
      .update({ coexistence_offboarded_at: event === 'ACCOUNT_OFFBOARDED' ? new Date().toISOString() : null })
      .in('id', ids)
      .eq('whatsapp_mode', 'coexistence')
      .select('id')
    if (updateError) throw updateError
    out[`${event}:${wabaId}`] = (changed ?? []).length
    console.warn(`${LOG} ${event === 'ACCOUNT_OFFBOARDED' ? 'offboarded by Meta: sends paused' : 'reconnected: sends resume'}`, { wabaId, channels: (changed ?? []).map((c) => c.id) })
  }
  return out
}
