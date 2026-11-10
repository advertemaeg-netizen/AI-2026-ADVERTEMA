import type { ChannelType } from './channels'

/**
 * One public comment, as the comments tab shows it (comments tab decisions,
 * section 3): who, what, on which post, what went out, on which channel.
 */
export type CommentItem = {
  /** The comment's row in its comment thread (messages.id) */
  id: string
  /** The platform's comment id: the anchor the private conversation links back to */
  commentId: string | null
  text: string
  createdAt: string
  contactName: string | null
  contactIdentifier: string | null
  client: { id: string; name: string }
  channel: { id: string; type: ChannelType; name: string }
  /** The post on the platform, when it can be linked */
  postUrl: string | null
  /** Our fixed public reply was posted under this comment */
  publicReplySent: boolean
  /** The private reply for THIS comment was sent (an earlier comment's DM is not this one's reply) */
  privateReplySent: boolean
  /** The person's private conversation on this channel, if there is one */
  dmConversationId: string | null
}

export type CommentFilters = { clientId?: string }

/** Where a private conversation began, when it began from a comment */
export type ConversationOrigin = { commentId: string | null }

/** The id a comment's row carries in the comments tab, for the link back from its conversation */
export function commentAnchor(commentId: string) {
  return `comment-${commentId.replace(/[^A-Za-z0-9_-]/g, '_')}`
}
