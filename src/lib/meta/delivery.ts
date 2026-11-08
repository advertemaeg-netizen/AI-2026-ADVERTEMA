import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { SendResult } from '@/lib/meta/send'
import type { InboundWhatsAppStatus } from '@/lib/meta/webhook'
import type { SendFailure } from '@/lib/types/conversations'

/**
 * WHAT BECAME OF AN OUTBOUND ROW: the one place a row's send is recorded,
 * for the bot's replies and notices and for a person's reply from the
 * dashboard alike (.scratch/agent-reply-decisions.md §2.2).
 *
 * metadata.send is written as 'sending' with the row, before the send is
 * attempted. Then:
 *   'sent'    with the outbound id Meta answered with. On Messenger that id
 *             is how the Page's echo is known as ours; on WhatsApp it is how
 *             a later status webhook finds the row.
 *   'failed'  with a reason the dashboard can say in plain words
 *             (SEND_FAILURES), and Meta's code when there is one. A bot
 *             reply also keeps metadata.delivery, as it always has.
 *
 * "SENT" ON WHATSAPP MEANS META ACCEPTED IT. WhatsApp can report the failure
 * afterwards, in a status webhook carrying the same id (the closed window
 * above all, 131047). applyWhatsAppStatus marks the row failed then. The
 * status can arrive before the send's answer has written the id: it is held
 * in meta_pending_statuses, and recordSent looks there after writing the
 * id. Each side writes first and looks second, so whichever is last finds
 * the other.
 *
 * On an agent row the database settles the needs-a-person mark from the
 * state (agent_send_outcome, 20261113100000): 'sent' clears it, 'failed'
 * sets it to 'send_failed'. Nothing here sets the mark.
 *
 * NEVER LOGGED: the text, the recipient. Logged: ids, states, reasons, codes.
 */

const SOURCE = 'webhook/meta'

/** Meta's code for a token that is no longer good: the channel has to be connected again */
const INVALID_TOKEN = 190
/** WhatsApp, in a status: the message went outside the 24-hour window */
const WHATSAPP_OUTSIDE_WINDOW = 131047
/** A held status older than this belongs to no row of ours (a message sent from elsewhere) */
const PENDING_KEEP_MS = 2 * 24 * 60 * 60_000

export type RowMetadata = Record<string, unknown> & { send?: { transport?: string; state?: string; messageId?: string | null; reason?: string; at?: string } }

/** A "send again" keeps the time it began on every state after it, so the inbox can tell a late 'sending' from a new one */
const attempt = (metadata: RowMetadata) => (metadata.send?.at ? { at: metadata.send.at } : {})

/** The reason the dashboard shows for a send that did not go */
export function failureReason(result: Exclude<SendResult, { kind: 'sent' }>): SendFailure {
  switch (result.kind) {
    case 'outside_window':
      return 'outside_window'
    case 'not_configured':
      return 'disconnected'
    case 'unsendable':
      return result.reason === 'too_long' ? 'too_long' : 'refused'
    case 'failed':
      return result.code === INVALID_TOKEN ? 'disconnected' : 'refused'
  }
}

export async function rowMetadata(supabase: SupabaseClient, rowId: string) {
  const { data, error } = await supabase.from('messages').select('metadata').eq('id', rowId).maybeSingle<{ metadata: RowMetadata | null }>()
  if (error) throw error
  return data ? (data.metadata ?? {}) : null
}

/** Meta took the message: the row records the outbound id. Then a status that came first is applied */
export async function recordSent(supabase: SupabaseClient, rowId: string, transport: string, messageId: string | null) {
  const metadata = await rowMetadata(supabase, rowId)
  if (!metadata) return
  const { error } = await supabase
    .from('messages')
    .update({ metadata: { ...metadata, send: { transport, state: 'sent', messageId, ...attempt(metadata) } } })
    .eq('id', rowId)
  if (error) {
    console.error(`[${SOURCE}] recording the sent message failed`, { messageId: rowId, error })
    return
  }
  if (transport === 'whatsapp' && messageId) await applyHeldStatus(supabase, rowId, messageId)
}

/**
 * The row the person never received, marked so the dashboard shows it, with
 * its reason. A bot reply keeps metadata.delivery as before. A row its echo
 * already proved delivered (the send timed out after Meta took it) is left
 * as delivered.
 */
export async function recordFailed(
  supabase: SupabaseClient,
  rowId: string,
  transport: string,
  failure: { reason: SendFailure; kind: string; code?: number | null; status?: number | null },
  { evenIfSent = false }: { evenIfSent?: boolean } = {}
) {
  const metadata = await rowMetadata(supabase, rowId)
  if (!metadata) return
  if (metadata.send?.state === 'sent' && !evenIfSent) return
  const { data: row } = await supabase.from('messages').select('role').eq('id', rowId).maybeSingle<{ role: string }>()
  const code = failure.code ?? null
  const send = { transport, state: 'failed', messageId: metadata.send?.messageId ?? null, reason: failure.reason, ...(code !== null ? { code } : {}), ...attempt(metadata) }
  const delivery =
    row?.role === 'assistant'
      ? { delivery: { transport, failed: failure.kind, at: new Date().toISOString(), ...(code !== null ? { code } : {}), ...(failure.status != null ? { status: failure.status } : {}) } }
      : {}
  const { error } = await supabase
    .from('messages')
    .update({ metadata: { ...metadata, ...delivery, send } })
    .eq('id', rowId)
  if (error) console.error(`[${SOURCE}] marking the undelivered message failed`, { messageId: rowId, error })
}

/** A send's result, recorded on its row: 'sent' with the id, or 'failed' with the reason */
export async function recordResult(supabase: SupabaseClient, rowId: string, transport: string, result: SendResult) {
  if (result.kind === 'sent') return recordSent(supabase, rowId, transport, result.messageId)
  return recordFailed(supabase, rowId, transport, {
    reason: failureReason(result),
    kind: result.kind,
    code: 'code' in result ? result.code : null,
    status: 'status' in result ? result.status : null,
  })
}

export type StatusDisposition = 'applied' | 'held' | 'ignored'

/**
 * A WhatsApp status webhook. Only 'failed' acts: 'sent', 'delivered' and
 * 'read' confirm what the row already says. The row is found by the id the
 * send recorded, in the recipient's conversation on the channel; with none
 * yet, the status is held until recordSent writes the id.
 */
export async function applyWhatsAppStatus(supabase: SupabaseClient, channelId: string, status: InboundWhatsAppStatus): Promise<StatusDisposition> {
  if (status.status !== 'failed') return 'ignored'
  const row = await rowFor(supabase, channelId, status)
  if (row) {
    await failFromStatus(supabase, row, status.errorCodes)
    return 'applied'
  }
  // Held, then looked for again: the send's answer may have landed in between
  const cutoff = new Date(Date.now() - PENDING_KEEP_MS).toISOString()
  await supabase.from('meta_pending_statuses').delete().eq('channel_id', channelId).lt('received_at', cutoff)
  const { error } = await supabase
    .from('meta_pending_statuses')
    .upsert({ message_id: status.messageId, channel_id: channelId, status: status.status, error_codes: status.errorCodes }, { onConflict: 'message_id' })
  if (error) throw error
  const late = await rowFor(supabase, channelId, status)
  if (late) {
    await failFromStatus(supabase, late, status.errorCodes)
    await supabase.from('meta_pending_statuses').delete().eq('message_id', status.messageId)
    return 'applied'
  }
  return 'held'
}

type OutboundRow = { id: string; metadata: RowMetadata | null }

async function rowFor(supabase: SupabaseClient, channelId: string, status: InboundWhatsAppStatus): Promise<OutboundRow | null> {
  let conversations = supabase.from('conversations').select('id').eq('channel_id', channelId).eq('thread', 'dm')
  if (status.recipientId) conversations = conversations.eq('contact_identifier', status.recipientId)
  const { data: found, error } = await conversations.returns<{ id: string }[]>()
  if (error) throw error
  if (!found.length) return null
  const { data, error: rowError } = await supabase
    .from('messages')
    .select('id, metadata')
    .in(
      'conversation_id',
      found.map((c) => c.id)
    )
    .in('role', ['assistant', 'agent'])
    .eq('metadata->send->>messageId', status.messageId)
    .limit(1)
    .returns<OutboundRow[]>()
  if (rowError) throw rowError
  return data[0] ?? null
}

async function failFromStatus(supabase: SupabaseClient, row: OutboundRow, errorCodes: number[]) {
  if (row.metadata?.send?.state === 'failed') return
  const outside = errorCodes.includes(WHATSAPP_OUTSIDE_WINDOW)
  await recordFailed(
    supabase,
    row.id,
    'whatsapp',
    { reason: outside ? 'outside_window' : 'refused', kind: outside ? 'outside_window' : 'failed', code: errorCodes[0] ?? null },
    // Meta accepted it, then reported it failed: the status is the later word
    { evenIfSent: true }
  )
  console.info(`[${SOURCE}] status failed`, { messageId: row.id, codes: errorCodes })
}

async function applyHeldStatus(supabase: SupabaseClient, rowId: string, messageId: string) {
  const { data, error } = await supabase
    .from('meta_pending_statuses')
    .select('error_codes')
    .eq('message_id', messageId)
    .maybeSingle<{ error_codes: number[] }>()
  if (error) {
    console.error(`[${SOURCE}] reading a held status failed`, { error })
    return
  }
  if (!data) return
  const metadata = await rowMetadata(supabase, rowId)
  if (metadata) await failFromStatus(supabase, { id: rowId, metadata }, data.error_codes)
  await supabase.from('meta_pending_statuses').delete().eq('message_id', messageId)
}
