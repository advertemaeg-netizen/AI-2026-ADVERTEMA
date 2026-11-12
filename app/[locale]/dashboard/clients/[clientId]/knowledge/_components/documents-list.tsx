'use client'

import { useEffect, useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { BookOpen, Download, ExternalLink, FileText, Loader2, Trash2 } from 'lucide-react'
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
import { deleteKnowledgeDocument, getKnowledgeFileUrl } from '@/lib/actions/knowledge'
import { fileSize, opensInTab, type KnowledgeDocument, type KnowledgeStatus } from '@/lib/types/knowledge'

const STATUS_STYLES: Record<KnowledgeStatus, string> = {
  processing: 'bg-warning-fill text-warning-fill-foreground',
  ready: 'bg-positive-fill text-positive-fill-foreground',
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
  const sizeText = (bytes: number) => {
    const size = fileSize(bytes)
    return `${format.number(size.value, { maximumFractionDigits: size.fractionDigits })} ${size.unit}`
  }
  const router = useRouter()
  const [deleting, setDeleting] = useState<KnowledgeDocument | null>(null)
  const [isDeleting, startDelete] = useTransition()
  const [downloadingId, setDownloadingId] = useState<string | null>(null)

  // The original file, as uploaded: a short-lived link made on the server, then followed
  async function handleDownload(doc: KnowledgeDocument) {
    setDownloadingId(doc.id)
    try {
      const result = await getKnowledgeFileUrl(doc.id)
      if (result.ok) window.location.assign(result.url)
      else toast.error(t(`errors.${result.error}`))
    } catch {
      toast.error(t('errors.unknown'))
    } finally {
      setDownloadingId(null)
    }
  }

  // A PDF in a new tab. The tab is opened on the click itself (a tab opened
  // after an await is a popup, and blocked), then sent to the link
  async function handleView(doc: KnowledgeDocument) {
    const tab = window.open('about:blank', '_blank')
    if (tab) tab.opener = null
    setDownloadingId(doc.id)
    try {
      const result = await getKnowledgeFileUrl(doc.id, 'view')
      if (result.ok && tab) tab.location.href = result.url
      else if (result.ok) window.location.assign(result.url)
      else {
        tab?.close()
        toast.error(t(`errors.${result.error}`))
      }
    } catch {
      tab?.close()
      toast.error(t('errors.unknown'))
    } finally {
      setDownloadingId(null)
    }
  }

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

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('list.title')}</CardTitle>
        <CardDescription>{t('list.summary', { documents: documents.length })}</CardDescription>
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
                      <> · {sizeText(doc.file_size)}</>
                    )}
                    {' · '}
                    <RelativeTime date={doc.created_at} />
                  </p>
                  {doc.status === 'failed' && doc.error_message && (
                    <p className="text-xs text-destructive">{t(`processingErrors.${doc.error_message}`)}</p>
                  )}
                </div>
                <Badge variant="secondary" className={STATUS_STYLES[doc.status]}>
                  {doc.status === 'processing' && <Loader2 className="animate-spin" />}
                  {t(`status.${doc.status}`)}
                </Badge>
                {opensInTab(doc.file_type) ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={`${t('viewInTab')}: ${doc.title}`}
                    title={t('viewInTab')}
                    disabled={downloadingId === doc.id}
                    onClick={() => handleView(doc)}
                  >
                    <ExternalLink className="rtl:-scale-x-100" />
                  </Button>
                ) : (
                  // Word and plain text: no tab that shows nothing. aria-disabled, not
                  // disabled, so the reason still shows on hover and is read out
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-disabled
                    aria-label={`${t('downloadOnly')}: ${doc.title}`}
                    title={t('downloadOnly')}
                    className="cursor-not-allowed opacity-40 hover:bg-transparent"
                    onClick={(e) => e.preventDefault()}
                  >
                    <ExternalLink className="rtl:-scale-x-100" />
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${t('download')}: ${doc.title}`}
                  title={t('download')}
                  disabled={downloadingId === doc.id}
                  onClick={() => handleDownload(doc)}
                >
                  {downloadingId === doc.id ? <Loader2 className="animate-spin" /> : <Download />}
                </Button>
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
