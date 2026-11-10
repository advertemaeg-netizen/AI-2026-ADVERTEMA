import { getTranslations } from 'next-intl/server'
import { MessageSquareQuote } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { getComments } from '@/lib/actions/comments'
import { getSelectedClient } from '@/lib/auth/client-context'
import { CommentRow } from './_components/comment-row'

/**
 * THE COMMENTS TAB (comments tab decisions, 1): public comments on the
 * clinic's Facebook and Instagram posts, apart from the private messages in
 * conversations. Scoped to the client picked in the sidebar switcher, if any.
 */
export default async function CommentsPage() {
  const selectedClient = await getSelectedClient()
  const t = await getTranslations('comments')
  const comments = await getComments(selectedClient ? { clientId: selectedClient.id } : {})

  return (
    <div className="page animate-enter">
      <div className="mb-6">
        <h1 className="page-title">{t('title')}</h1>
      </div>

      <Card className="py-0">
        <CardContent className="px-0">
          {comments.length === 0 ? (
            // An empty state: the one place on a working screen that keeps the field's warmth (7.1)
            <div className="empty-field flex flex-col items-center gap-2 rounded-[inherit] px-6 py-16 text-center">
              <MessageSquareQuote className="size-8 text-muted-foreground" aria-hidden />
              <h2 className="font-semibold">{t('empty.heading')}</h2>
              <p className="max-w-md text-sm text-muted-foreground">{t('empty.body')}</p>
            </div>
          ) : (
            <ul className="divide-y">
              {comments.map((comment) => (
                <li key={comment.id}>
                  <CommentRow comment={comment} />
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  )
}
