import 'server-only'
import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * IDEMPOTENCY, BEFORE ANYTHING ACTS (.scratch/whatsapp-send-design.md §2).
 *
 * Meta retries on a timeout, on a non-200, and sometimes on a 200 it did not
 * read in time, and a retry carries the same message id (the wamid). Every
 * inbound message id is written to processed_meta_messages before the
 * conversation is touched, the model is called or anything is sent:
 * `insert … on conflict do nothing`, and whether a row was inserted decides.
 * A table with a primary key, not a cache: the container restarts and Meta
 * retries across restarts.
 *
 * Insert-first means a crash between the claim and the reply loses that
 * message: the retry is a duplicate by then. The right trade (a duplicate
 * reply is visible and looks broken; a dropped one is silent), so the silent
 * case is made findable: completed_at is null from the claim until
 * processing finishes, and a row still null after a few minutes is a message
 * we swallowed. No retry, no sweeper; the count is the signal.
 */

export type MessageClaim = { messageId: string; channelId: string }

/**
 * Claims the delivery's message ids in one statement and returns the ones
 * that were new. An id already there is a repeat: nothing is to be done for
 * it. Throws on a database error, and the caller must then act on nothing:
 * an unclaimed message is one that may already have been answered.
 */
export async function claimMessages(supabase: SupabaseClient, claims: MessageClaim[]): Promise<Set<string>> {
  if (claims.length === 0) return new Set()
  // One row per id: the same id twice in one delivery is one claim
  const rows = [...new Map(claims.map((claim) => [claim.messageId, { message_id: claim.messageId, channel_id: claim.channelId }])).values()]
  const { data, error } = await supabase
    .from('processed_meta_messages')
    .upsert(rows, { onConflict: 'message_id', ignoreDuplicates: true })
    .select('message_id')
    .returns<{ message_id: string }[]>()
  if (error) throw error
  return new Set(data.map((row) => row.message_id))
}

/**
 * Processing finished for these ids: their rows are closed. Throws on a
 * database error; the messages were dealt with, the rows just fail to say so,
 * and they will then count as swallowed until someone looks.
 */
export async function completeMessages(supabase: SupabaseClient, ids: Iterable<string>): Promise<void> {
  const list = [...ids]
  if (list.length === 0) return
  const { error } = await supabase.from('processed_meta_messages').update({ completed_at: new Date().toISOString() }).in('message_id', list)
  if (error) throw error
}

/**
 * Messages claimed and never completed, received more than `minutes` ago:
 * the ones the server swallowed. Visibility only: nothing acts on the count.
 */
export async function swallowedMessages(supabase: SupabaseClient, minutes = 5): Promise<number> {
  const before = new Date(Date.now() - minutes * 60_000).toISOString()
  const { count, error } = await supabase
    .from('processed_meta_messages')
    .select('message_id', { count: 'exact', head: true })
    .is('completed_at', null)
    .lt('received_at', before)
  if (error) throw error
  return count ?? 0
}
