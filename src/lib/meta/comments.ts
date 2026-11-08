import 'server-only'
import { randomInt } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import { COMMENT_PRIVATE_OPENER_AR, COMMENT_PUBLIC_INVITE_AR, COMMENT_PUBLIC_SENT_AR } from '@/lib/meta/comment-strings-ar'
import { conversationFor, isLive, type InboundChannel } from '@/lib/meta/inbound'
import { INSTAGRAM_MAX_TEXT_BYTES, postInstagramCommentReply, sendInstagramPrivateReply, type PublicReplyResult, type SendResult } from '@/lib/meta/send'
import type { InboundInstagramComment } from '@/lib/meta/webhook'
import { WHATSAPP_PLACEHOLDER_AR } from '@/lib/meta/whatsapp-notices-ar'

/**
 * INSTAGRAM COMMENTS (.scratch/messenger-instagram-design.md §2;
 * .scratch/comments-decisions-and-arabic.md, which decides the shape).
 *
 * THE MODEL NEVER WRITES PUBLIC TEXT. Nothing on this path calls it: not to
 * write, not to choose, not to adapt. The public reply is one of the copy
 * owner's fixed strings, picked by code, so none of the public-reply rules
 * (no medical complaint repeated, no name or number asked, no booking, no
 * price, no doctor named) can be broken: there is no way to write anything
 * new in public. The checks below (no digits, a length cap) are kept anyway:
 * a guarantee and a check that agree are how we find out when one is wrong.
 *
 * THE ORDER, for a comment on the client's own media while the client's
 * switch is on:
 *   1. CLAIM the comment id (meta_comment_replies), before anything acts. A
 *      retry, a boosted post's duplicate, the same comment twice: the claim
 *      exists and nothing happens. A duplicate public reply is the failure
 *      the whole page can read.
 *   2. Is it ours? Our own public replies come back as comments. Known by
 *      the ids we recorded, by being exactly one of our strings, or by being
 *      the account's own: never answered.
 *   3. The comment goes into the person's comment thread (conversations,
 *      thread 'comments'), which holds public comments and our public
 *      replies and nothing else.
 *   4. The PRIVATE reply first: the opener, sent as a private reply to the
 *      comment. On success its DM conversation (thread 'dm', keyed by the
 *      Instagram-scoped id Meta answers with) gets the opener as its first
 *      row, and the thread is an ordinary conversation from there.
 *   5. Then the PUBLIC reply: set A ("we've messaged you") only if the
 *      private reply went; the invite (set B) if it did not. A public promise
 *      of a message never sent is a lie the whole page can read.
 *   6. A public reply that fails is logged and left. Attempted once, never
 *      retried (a retry could post it twice).
 *
 * Not answered, by rule (decided 2026-11-04), and stored all the same:
 *   - a reply inside a comment thread (parent_id set);
 *   - PRIVATE: a commenter whose earlier comment already opened a DM. No
 *     second opener, ever: the DM is open, that is where the conversation is;
 *   - PUBLIC: ONE PUBLIC REPLY PER PERSON PER POST, EVER. Their first comment
 *     on a post gets one; every later comment by them on that post gets none.
 *     Four public replies to one person under one post read as a machine,
 *     and the fourth adds nothing. Silence is the better behaviour.
 * A person with a DM already open who comments on ANOTHER post gets that
 * post's one public reply from set A ("we've messaged you" is true: the DM
 * exists) and no opener.
 *
 * NEVER LOGGED: the comment's text, the commenter's id or username, the
 * opener. Logged: the channel, the comment id, the decision, the states, and
 * whether the private reply's recipient id equals the comment's author id
 * (a boolean: the Instagram identity question, answered one comment at a
 * time, without an id in the log).
 */

const SOURCE = 'webhook/meta'
/** A public reply longer than this is not one of ours: refuse it */
const PUBLIC_MAX_CHARS = 300
const DIGITS = /[0-9٠-٩۰-۹]/
const OUR_PUBLIC_STRINGS = new Set<string>([...COMMENT_PUBLIC_SENT_AR, COMMENT_PUBLIC_INVITE_AR])

export type CommentDisposition =
  /** The channel, client or organization is off: nothing stored */
  | { kind: 'inactive' }
  /** The client's comment replies are switched off: nothing stored, nothing claimed */
  | { kind: 'switched_off' }
  /** Already claimed: a retry or a duplicate notification. Nothing done */
  | { kind: 'duplicate' }
  | { kind: 'skipped'; reason: 'own_reply' | 'own_text' | 'own_account' | 'reply_in_thread' }
  | {
      kind: 'replied'
      privateReply: SendResult['kind'] | 'already_opened'
      publicReply: PublicReplyResult['kind'] | 'refused_by_check' | 'already_replied_on_post'
      variant: string | null
    }

/** The opener with the clinic's name; with none, " في {{clinic}}" is dropped whole (the owner's rule) */
export function openerFor(clinicName: string | null | undefined) {
  const name = clinicName?.trim()
  return name ? COMMENT_PRIVATE_OPENER_AR.replace('{{clinic}}', name) : COMMENT_PRIVATE_OPENER_AR.replace(' في {{clinic}}', '')
}

/** The public reply's checks: a guarantee (fixed strings) and a check that must agree with it */
function passesPublicChecks(text: string) {
  return OUR_PUBLIC_STRINGS.has(text) && !DIGITS.test(text) && [...text].length <= PUBLIC_MAX_CHARS && Buffer.byteLength(text, 'utf8') <= INSTAGRAM_MAX_TEXT_BYTES
}

export async function handleInstagramComment({
  supabase,
  channel,
  comment,
}: {
  /** The service-role client: the webhook runs as nobody */
  supabase: SupabaseClient
  channel: InboundChannel
  comment: InboundInstagramComment
}): Promise<CommentDisposition> {
  if (!isLive(channel)) return { kind: 'inactive' }
  if (channel.clients?.comment_replies_enabled !== true) return { kind: 'switched_off' }

  // 1. THE CLAIM, before anything acts
  if (!(await claim(supabase, comment.commentId, channel.id))) {
    console.info(`[${SOURCE}] comment duplicate`, { channelId: channel.id, commentId: comment.commentId })
    return { kind: 'duplicate' }
  }

  // 2. Ours? Recorded ids first; then our own strings; then the account itself
  const own = await ownReason(supabase, comment)
  if (own) {
    await record(supabase, comment.commentId, { decision: own, completed_at: new Date().toISOString() })
    console.info(`[${SOURCE}] comment skipped`, { channelId: channel.id, commentId: comment.commentId, reason: own })
    return { kind: 'skipped', reason: own }
  }

  // 3. Into the person's comment thread: public comments and our public replies only
  const threadId = await commentThreadFor(supabase, channel, comment)
  const { data: stored, error: storeError } = await supabase
    .from('messages')
    .insert({
      conversation_id: threadId,
      role: 'user',
      content: comment.text?.trim() || WHATSAPP_PLACEHOLDER_AR.unsupported,
      metadata: { transport: 'instagram', comment: { commentId: comment.commentId, mediaId: comment.mediaId ?? null, parentId: comment.parentId ?? null, adId: comment.adId ?? null } },
    })
    .select('id, metadata')
    .single<{ id: string; metadata: Record<string, unknown> }>()
  if (storeError) throw storeError

  if (comment.parentId) {
    await record(supabase, comment.commentId, { decision: 'reply_in_thread', completed_at: new Date().toISOString() })
    console.info(`[${SOURCE}] comment skipped`, { channelId: channel.id, commentId: comment.commentId, reason: 'reply_in_thread' })
    return { kind: 'skipped', reason: 'reply_in_thread' }
  }

  // 4. THE PRIVATE REPLY FIRST, unless an earlier comment of theirs already opened a DM
  let privateReply: SendResult['kind'] | 'already_opened'
  if (await alreadyOpened(supabase, threadId, stored.id)) {
    privateReply = 'already_opened'
    await record(supabase, comment.commentId, { decision: 'reply', private_state: 'skipped:already_opened' })
  } else {
    await record(supabase, comment.commentId, { decision: 'reply', private_state: 'sending' })
    const opener = openerFor(channel.clients?.name)
    const result = await sendInstagramPrivateReply({ supabase, channelId: channel.id, commentId: comment.commentId, body: opener })
    privateReply = result.kind
    if (result.kind === 'sent') {
      const dmConversationId = await openDm(supabase, channel, result, opener, comment)
      await record(supabase, comment.commentId, { private_state: 'sent', private_message_id: result.messageId, dm_conversation_id: dmConversationId })
      console.info(`[${SOURCE}] comment private reply sent`, {
        channelId: channel.id,
        commentId: comment.commentId,
        dmConversationId,
        // The Instagram identity question, as a boolean: is the commenter's id the id their DM carries?
        recipientIsCommenter: result.recipientId == null ? null : result.recipientId === comment.from.id,
      })
    } else {
      await record(supabase, comment.commentId, { private_state: `failed:${result.kind}` })
    }
  }
  // The comment row says what its private reply did: how a later comment of theirs knows a DM is open
  await supabase
    .from('messages')
    .update({ metadata: { ...stored.metadata, privateReply } })
    .eq('id', stored.id)

  // 5. THE PUBLIC REPLY, one per person per post, ever: set A if their DM is open (sent now, or
  // opened by an earlier comment); the invite if the private reply did not go
  if (await alreadyRepliedOnPost(supabase, threadId, comment.mediaId)) {
    await record(supabase, comment.commentId, { public_state: 'skipped:already_replied_on_post', completed_at: new Date().toISOString() })
    console.info(`[${SOURCE}] comment answered`, { channelId: channel.id, commentId: comment.commentId, privateReply, publicReply: 'already_replied_on_post' })
    return { kind: 'replied', privateReply, publicReply: 'already_replied_on_post', variant: null }
  }
  const dmOpen = privateReply === 'sent' || privateReply === 'already_opened'
  const variant = dmOpen ? `sent_${randomInt(COMMENT_PUBLIC_SENT_AR.length) + 1}` : 'invite'
  const text = variant === 'invite' ? COMMENT_PUBLIC_INVITE_AR : COMMENT_PUBLIC_SENT_AR[Number(variant.slice(5)) - 1]
  if (!passesPublicChecks(text)) {
    // Cannot happen with the fixed strings; if it does, one of the two is wrong, and nothing is posted
    await record(supabase, comment.commentId, { public_variant: variant, public_state: 'refused_by_check', completed_at: new Date().toISOString() })
    console.error(`[${SOURCE}] a public reply failed its own checks: not posted`, { channelId: channel.id, commentId: comment.commentId, variant })
    return { kind: 'replied', privateReply, publicReply: 'refused_by_check', variant }
  }
  await record(supabase, comment.commentId, { public_variant: variant, public_state: 'posting' })
  const posted = await postInstagramCommentReply({ supabase, channelId: channel.id, commentId: comment.commentId, body: text })
  if (posted.kind === 'posted') {
    await record(supabase, comment.commentId, { public_state: 'posted', public_comment_id: posted.commentId, completed_at: new Date().toISOString() })
    const { error } = await supabase.from('messages').insert({
      conversation_id: threadId,
      role: 'assistant',
      content: text,
      metadata: { transport: 'instagram', commentReply: { commentId: comment.commentId, mediaId: comment.mediaId ?? null, replyId: posted.commentId, variant, privateReply } },
    })
    if (error) console.error(`[${SOURCE}] storing the public reply failed`, { channelId: channel.id, commentId: comment.commentId, error })
  } else {
    // 6. Logged and left: the private reply, which matters more, already went
    await record(supabase, comment.commentId, { public_state: `failed:${posted.kind}`, completed_at: new Date().toISOString() })
  }
  console.info(`[${SOURCE}] comment answered`, { channelId: channel.id, commentId: comment.commentId, privateReply, publicReply: posted.kind, variant })
  return { kind: 'replied', privateReply, publicReply: posted.kind, variant }
}

/** The claim: inserted once, or not at all. Whether a row was inserted decides */
async function claim(supabase: SupabaseClient, commentId: string, channelId: string) {
  const { data, error } = await supabase
    .from('meta_comment_replies')
    .upsert({ comment_id: commentId, channel_id: channelId }, { onConflict: 'comment_id', ignoreDuplicates: true })
    .select('comment_id')
    .returns<{ comment_id: string }[]>()
  if (error) throw error
  return data.length > 0
}

async function record(supabase: SupabaseClient, commentId: string, fields: Record<string, unknown>) {
  const { error } = await supabase.from('meta_comment_replies').update(fields).eq('comment_id', commentId)
  if (error) console.error(`[${SOURCE}] recording the comment's state failed`, { commentId, fields: Object.keys(fields), error })
}

/**
 * Whether the comment is ours. Recorded ids decide, as for Messenger echoes;
 * our reply can come back before its id is recorded, so a comment that is
 * exactly one of our public strings is ours too; and a comment by the account
 * itself (a person at the clinic) is never answered by the bot.
 */
async function ownReason(supabase: SupabaseClient, comment: InboundInstagramComment): Promise<'own_reply' | 'own_text' | 'own_account' | null> {
  const { data, error } = await supabase.from('meta_comment_replies').select('comment_id').eq('public_comment_id', comment.commentId).limit(1)
  if (error) throw error
  if (data.length > 0) return 'own_reply'
  if (comment.text !== undefined && OUR_PUBLIC_STRINGS.has(comment.text.trim())) return 'own_text'
  if (comment.from.id === comment.accountId) return 'own_account'
  return null
}

/** The person's comment thread on this channel: (channel, commenter id, 'comments'), never the DM */
async function commentThreadFor(supabase: SupabaseClient, channel: InboundChannel, comment: InboundInstagramComment) {
  const find = async () => {
    const { data, error } = await supabase
      .from('conversations')
      .select('id')
      .eq('channel_id', channel.id)
      .eq('contact_identifier', comment.from.id)
      .eq('thread', 'comments')
      .maybeSingle<{ id: string }>()
    if (error) throw error
    return data?.id ?? null
  }
  const existing = await find()
  if (existing) return existing
  const { data: created, error: insertError } = await supabase
    .from('conversations')
    .insert({
      client_id: channel.client_id,
      channel_id: channel.id,
      contact_identifier: comment.from.id,
      contact_name: comment.from.username?.slice(0, 100) || null,
      thread: 'comments',
      status: 'new',
      // The bot never answers inside a comment thread: only the fixed public strings are posted there
      auto_reply_enabled: false,
    })
    .select('id')
    .single<{ id: string }>()
  if (insertError) {
    // Two comments from one person at once: the other one opened the thread first (20261114100000)
    if (insertError.code === '23505') {
      const winner = await find()
      if (winner) return winner
    }
    throw insertError
  }
  return created.id
}

/** Whether an earlier comment in this thread already had its private reply sent */
async function alreadyOpened(supabase: SupabaseClient, threadId: string, currentRowId: string) {
  const { data, error } = await supabase
    .from('messages')
    .select('id, metadata')
    .eq('conversation_id', threadId)
    .eq('role', 'user')
    .returns<{ id: string; metadata: { privateReply?: string } | null }[]>()
  if (error) throw error
  return data.some((row) => row.id !== currentRowId && row.metadata?.privateReply === 'sent')
}

/**
 * Whether we already posted a public reply to this person under this post:
 * one per person per post, ever. Read from the person's comment thread, where
 * every public reply we posted is a row carrying the post's media id. A
 * public reply that failed is not a reply, so it does not count.
 */
async function alreadyRepliedOnPost(supabase: SupabaseClient, threadId: string, mediaId: string | undefined) {
  const { data, error } = await supabase
    .from('messages')
    .select('metadata')
    .eq('conversation_id', threadId)
    .eq('role', 'assistant')
    .returns<{ metadata: { commentReply?: { mediaId?: string | null } } | null }[]>()
  if (error) throw error
  return data.some((row) => (row.metadata?.commentReply?.mediaId ?? null) === (mediaId ?? null))
}

/**
 * The DM the private reply opened: keyed by the Instagram-scoped id Meta
 * answered with (never the comment's author id assumed to be the same), in
 * thread 'dm', with the opener as its row. It may carry the originating
 * comment's id as context; never the private side's history on the public one.
 */
async function openDm(supabase: SupabaseClient, channel: InboundChannel, result: Extract<SendResult, { kind: 'sent' }>, opener: string, comment: InboundInstagramComment) {
  const { commentId } = comment
  if (!result.recipientId) {
    console.error(`[${SOURCE}] a private reply went without a recipient id: its DM is not opened here`, { channelId: channel.id, commentId })
    return null
  }
  // Named after the commenter, as their comment thread is: one patient must not read as
  // "@username" in one row and "visitor 87…" in the next (seen live, 2026-11-08)
  const username = comment.from.username?.trim().slice(0, 100) || undefined
  const { conversationId } = await conversationFor(supabase, channel, result.recipientId, username)
  if (username) {
    // A DM they opened before commenting has no name yet: it takes this one, and never replaces one
    const { error: nameError } = await supabase.from('conversations').update({ contact_name: username }).eq('id', conversationId).is('contact_name', null)
    if (nameError) console.error(`[${SOURCE}] naming the DM failed`, { channelId: channel.id, conversationId, error: nameError })
  }
  const { error } = await supabase.from('messages').insert({
    conversation_id: conversationId,
    role: 'assistant',
    content: opener,
    metadata: { transport: 'instagram', origin: { commentId }, send: { transport: 'instagram', state: 'sent', messageId: result.messageId } },
  })
  if (error) console.error(`[${SOURCE}] storing the opener failed`, { channelId: channel.id, conversationId, error })
  return conversationId
}
