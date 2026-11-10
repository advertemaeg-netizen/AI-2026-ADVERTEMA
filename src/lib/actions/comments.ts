'use server'

import { getSession } from '@/lib/auth/session'
import { createAdminClient } from '@/lib/supabase/admin'
import { fetchInstagramPermalinks } from '@/lib/meta/send'
import type { ChannelType } from '@/lib/types/channels'
import type { CommentFilters, CommentItem } from '@/lib/types/comments'

const LIST_LIMIT = 100

/*
 * THE COMMENTS TAB (comments tab decisions, 1 to 3). A public comment lives in
 * its author's comment thread (conversations.thread 'comments',
 * src/lib/meta/comments.ts): one row per comment (role 'user', metadata.comment
 * the platform's ids, metadata.privateReply what its private reply did), and
 * one per public reply we posted (role 'assistant', metadata.commentReply
 * naming the comment it answered). The private conversation a private reply
 * opened is found by its opener, whose metadata.origin.commentId names the
 * comment: NOT by the commenter's id, because that conversation is keyed by
 * the id Meta answered the send with, and on Facebook that is another id
 * (src/lib/meta/comments.ts, openDm). A person's later comments, whose private
 * reply was skipped because one was already open, link to that same
 * conversation: it is their thread's. Everything is read under the user's
 * RLS; only the Instagram post links need the channel's token, read with the
 * service role.
 */

type CommentRow = {
  id: string
  content: string
  created_at: string
  comment: { commentId?: string | null; postId?: string | null; mediaId?: string | null } | null
  privateReply: string | null
  conversation: {
    id: string
    contact_name: string | null
    contact_identifier: string | null
    client: { id: string; name: string }
    channel: { id: string; type: ChannelType; name: string }
  }
}

export async function getComments(filters: CommentFilters = {}): Promise<CommentItem[]> {
  const { supabase, profile } = await getSession()
  if (!profile) return []

  let query = supabase
    .from('messages')
    .select(
      `id, content, created_at, comment:metadata->comment, privateReply:metadata->>privateReply,
       conversation:conversations!inner(id, contact_name, contact_identifier, thread,
         client:clients!inner(id, name), channel:channels!inner(id, type, name))`
    )
    .eq('role', 'user')
    .eq('conversation.thread', 'comments')
    .order('created_at', { ascending: false })
    .limit(LIST_LIMIT)
  if (filters.clientId) query = query.eq('conversation.client_id', filters.clientId)

  const { data, error } = await query.returns<CommentRow[]>()
  if (error) throw new Error(`Failed to load comments: ${error.message}`)
  if (data.length === 0) return []

  const threadIds = [...new Set(data.map((row) => row.conversation.id))]

  const [replies, dms, permalinks] = await Promise.all([
    // Our public replies in these threads, by the comment each answered
    supabase
      .from('messages')
      .select('reply:metadata->commentReply')
      .eq('role', 'assistant')
      .in('conversation_id', threadIds)
      .returns<{ reply: { commentId?: string | null } | null }[]>(),
    privateConversations(supabase, threadIds),
    instagramPermalinks(data),
  ])
  if (replies.error) throw new Error(`Failed to load comment replies: ${replies.error.message}`)

  const answered = new Set(replies.data.map((row) => row.reply?.commentId).filter((id): id is string => !!id))

  return data.map((row) => {
    const { conversation } = row
    const commentId = row.comment?.commentId ?? null
    return {
      id: row.id,
      commentId,
      text: row.content,
      createdAt: row.created_at,
      contactName: conversation.contact_name,
      contactIdentifier: conversation.contact_identifier,
      client: conversation.client,
      channel: conversation.channel,
      postUrl: postUrl(conversation.channel.type, row.comment, permalinks),
      publicReplySent: !!commentId && answered.has(commentId),
      privateReplySent: row.privateReply === 'sent',
      dmConversationId: dms.get(conversation.id) ?? null,
    }
  })
}

type Supabase = Awaited<ReturnType<typeof getSession>>['supabase']

/**
 * Each comment thread's private conversation: the comments in it whose private
 * reply was sent, then the openers that name those comments. Thread id → DM id.
 */
async function privateConversations(supabase: Supabase, threadIds: string[]): Promise<Map<string, string>> {
  const { data: opened, error } = await supabase
    .from('messages')
    .select('conversation_id, commentId:metadata->comment->>commentId')
    .in('conversation_id', threadIds)
    .eq('role', 'user')
    .eq('metadata->>privateReply', 'sent')
    .returns<{ conversation_id: string; commentId: string | null }[]>()
  if (error) throw new Error(`Failed to load comment private replies: ${error.message}`)
  const threadOf = new Map(opened.filter((row) => row.commentId).map((row) => [row.commentId!, row.conversation_id]))
  if (threadOf.size === 0) return new Map()

  const { data: openers, error: openersError } = await supabase
    .from('messages')
    .select('conversation_id, commentId:metadata->origin->>commentId')
    .in('metadata->origin->>commentId', [...threadOf.keys()])
    .returns<{ conversation_id: string; commentId: string | null }[]>()
  if (openersError) throw new Error(`Failed to load comment conversations: ${openersError.message}`)
  const dms = new Map<string, string>()
  for (const opener of openers) {
    const thread = opener.commentId ? threadOf.get(opener.commentId) : undefined
    if (thread) dms.set(thread, opener.conversation_id)
  }
  return dms
}

/** A Facebook post id is "{page id}_{post id}": the post's own page on facebook.com. Instagram's come from the Graph API */
function postUrl(type: ChannelType, comment: CommentRow['comment'], instagram: Map<string, string>): string | null {
  if (type === 'facebook' && comment?.postId) {
    const [pageId, postId] = comment.postId.split('_')
    return pageId && postId && /^[0-9]+$/.test(pageId) && /^[0-9]+$/.test(postId) ? `https://www.facebook.com/${pageId}/posts/${postId}` : null
  }
  if (type === 'instagram' && comment?.mediaId) return instagram.get(comment.mediaId) ?? null
  return null
}

/** One multi-id read per Instagram channel on the page; a failure leaves its posts unlinked */
async function instagramPermalinks(rows: CommentRow[]): Promise<Map<string, string>> {
  const byChannel = new Map<string, string[]>()
  for (const row of rows) {
    const mediaId = row.comment?.mediaId
    if (row.conversation.channel.type !== 'instagram' || !mediaId) continue
    byChannel.set(row.conversation.channel.id, [...(byChannel.get(row.conversation.channel.id) ?? []), mediaId])
  }
  if (byChannel.size === 0) return new Map()
  const admin = createAdminClient()
  const maps = await Promise.all(
    [...byChannel].map(([channelId, mediaIds]) => fetchInstagramPermalinks({ supabase: admin, channelId, mediaIds }))
  )
  return new Map(maps.flatMap((map) => [...map]))
}
