'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { BookOpen, FileText, Loader2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { RelativeTime } from '@/components/relative-time'
import { deleteKnowledgeDocument } from '@/lib/actions/knowledge'
import type { KnowledgeDocument, KnowledgeStatus } from '@/lib/types/knowledge'

const STATUS_STYLES: Record<KnowledgeStatus, string> = {
  processing: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  ready: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  failed: 'bg-destructive/10 text-destructive',
}

// Processing runs in the background after upload; refresh until it settles.
// (Realtime isn't used here: chunk inserts would stream every embedding.)
const REFRESH_WHILE_PROCESSING_MS = 4000

export function DocumentsList({
  documents,
  canManage,
}: {
  documents: KnowledgeDocument[]
  canManage: boolean
}) {
  const t = useTranslations('knowledge')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const router = useRouter()
  const [deleting, setDeleting] = useState<KnowledgeDocument | null>(null)
  const [isDeleting, startDelete] = useTransition()

  const processing = documents.some((doc) => doc.status === 'processing')
  useEffect(() => {
    if (!processing) return
    const timer = setInterval(() => router.refresh(), REFRESH_WHILE_PROCESSING_MS)
    return () => clearInterval(timer)
  }, [processing, router])

  function handleDelete(e: React.MouseEvent) {
    e.preventDefault()
    if (!deleting) return
    startDelete(async () => {
      const result = await deleteKnowledgeDocument(deleting.id)
      if (result.ok) {
        toast.success(t('toast.deleted'))
        setDeleting(null)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  const totalChunks = documents.reduce((sum, doc) => sum + (doc.chunk_count ?? 0), 0)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('list.title')}</CardTitle>
        <CardDescription>
          {t('list.summary', { documents: documents.length, chunks: totalChunks })}
        </CardDescription>
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-center text-sm text-muted-foreground">
            <BookOpen className="size-8" />
            {canManage ? t('list.empty') : t('list.emptyReadOnly')}
          </div>
        ) : (
          <ul className="divide-y">
            {documents.map((doc) => (
              <li key={doc.id} className="flex items-center gap-3 py-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
                  <FileText className="size-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium" title={doc.title}>
                    {doc.title}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {doc.file_type?.toUpperCase()}
                    {doc.file_size != null && (
                      <> · {format.number(doc.file_size / 1024 / 1024, { maximumFractionDigits: 1 })} MB</>
                    )}
                    {' · '}
                    <RelativeTime date={doc.created_at} />
                    {doc.status === 'ready' && <> · {t('list.chunks', { count: doc.chunk_count ?? 0 })}</>}
                  </p>
                  {doc.status === 'failed' && doc.error_message && (
                    <p className="text-xs text-destructive">{t(`processingErrors.${doc.error_message}`)}</p>
                  )}
                </div>
                <Badge variant="secondary" className={STATUS_STYLES[doc.status]}>
                  {doc.status === 'processing' && <Loader2 className="animate-spin" />}
                  {t(`status.${doc.status}`)}
                </Badge>
                {canManage && (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="text-destructive hover:text-destructive"
                    aria-label={`${tCommon('delete')} ${doc.title}`}
                    onClick={() => setDeleting(doc)}
                  >
                    <Trash2 />
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>

      <AlertDialog
        open={!!deleting}
        onOpenChange={(open) => !open && !isDeleting && setDeleting(null)}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('deleteDescription', { name: deleting?.title ?? '' })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={handleDelete} disabled={isDeleting}>
              {isDeleting ? tCommon('loading') : tCommon('delete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  )
}
