import { useTranslations } from 'next-intl'
import { ExternalLink, MessagesSquare } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { RelativeTime } from '@/components/relative-time'
import { CommentMarker } from '@/components/comment-marker'
import { commentAnchor, type CommentItem } from '@/lib/types/comments'
import { ContactAvatar, useChannelName, useContactLabel } from '../../conversations/_components/conversation-bits'

/**
 * One public comment (comments tab decisions, 3): who, the comment, its post,
 * what went out, the channel. No public reply is typed here (decision 4): the
 * way to answer is the private conversation, one click away.
 */
export function CommentRow({ comment }: { comment: CommentItem }) {
  const t = useTranslations('comments')
  const contactLabel = useContactLabel()
  const channelName = useChannelName()
  const name = contactLabel({ contact_name: comment.contactName, contact_identifier: comment.contactIdentifier })

  return (
    <article
      id={comment.commentId ? commentAnchor(comment.commentId) : undefined}
      // Arriving from its private conversation: the row is the page's target, and says so
      className="flex scroll-mt-24 gap-3 px-4 py-3 target:bg-accent"
    >
      <ContactAvatar
        name={comment.contactName}
        channelType={comment.channel.type}
        surface="comment"
        // A Facebook comment is not Messenger's: its glyph is Facebook's, and the
        // owner's names have none for it, so it carries no tooltip
        channelLabel={comment.channel.type === 'facebook' ? undefined : channelName(comment.channel.type)}
      />

      <div className="min-w-0 flex-1">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <p dir="auto" className="truncate font-medium">{name}</p>
            <CommentMarker />
          </div>
          <RelativeTime date={comment.createdAt} className="shrink-0 text-xs text-muted-foreground" />
        </div>
        <p className="flex min-w-0 gap-1 text-xs text-muted-foreground">
          <span dir="auto" className="min-w-0 truncate">{comment.client.name}</span>
          <span aria-hidden>·</span>
          <span dir="auto" className="min-w-0 truncate">{comment.channel.name}</span>
        </p>

        {/* The comment as written; it opens its post on the platform when the post can be linked */}
        <blockquote className="mt-2 border-s-2 border-foreground/30 ps-3 text-sm">
          {comment.postUrl ? (
            <a
              href={comment.postUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="group inline underline-offset-4 hover:underline focus-visible:underline"
            >
              <span dir="auto" className="whitespace-pre-line break-words">{comment.text}</span>
              <ExternalLink className="ms-1 inline size-3.5 align-[-0.125em] text-muted-foreground rtl:-scale-x-100" aria-hidden />
            </a>
          ) : (
            <span dir="auto" className="whitespace-pre-line break-words">{comment.text}</span>
          )}
        </blockquote>

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1.5">
            {comment.publicReplySent && <Badge variant="positive">{t('publicSent')}</Badge>}
            {comment.privateReplySent && <Badge variant="positive">{t('privateSent')}</Badge>}
            {!comment.publicReplySent && !comment.privateReplySent && <Badge variant="quiet">{t('noReply')}</Badge>}
          </div>
          {comment.dmConversationId && (
            <Button variant="outline" size="sm" asChild>
              <Link href={`/dashboard/conversations/${comment.dmConversationId}`}>
                <MessagesSquare aria-hidden />
                {t('openDm')}
              </Link>
            </Button>
          )}
        </div>
      </div>
    </article>
  )
}
