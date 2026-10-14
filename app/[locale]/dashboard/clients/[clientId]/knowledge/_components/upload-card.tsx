'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { AlertTriangle, FileUp, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import { usageLevel } from '@/components/billing/usage-bars'
import {
  KNOWLEDGE_ACCEPT,
  MAX_KNOWLEDGE_FILE_SIZE_MB,
  knowledgeFileType,
  type KnowledgeQuota,
  type KnowledgeUploadFailure,
} from '@/lib/types/knowledge'

type UploadState = { name: string; progress: number } | null

/** POSTs with XMLHttpRequest because fetch can't report upload progress. */
function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void
): Promise<{ ok: true } | KnowledgeUploadFailure> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      const body = xhr.response as KnowledgeUploadFailure | null
      resolve(
        xhr.status >= 200 && xhr.status < 300
          ? { ok: true }
          : { ...body, ok: false, error: body?.error ?? 'uploadFailed' }
      )
    }
    xhr.onerror = () => resolve({ ok: false, error: 'uploadFailed' })
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

/** The failure as a sentence a clinic owner can act on. */
function useFailureMessage() {
  const t = useTranslations('knowledge')
  const tLimits = useTranslations('knowledgeLimits')
  const format = useFormatter()
  return (failure: KnowledgeUploadFailure) => {
    // No chunks in the body: nothing fits, whatever the file
    if (failure.error === 'chunkLimit') return tLimits(failure.chunks ? 'chunkLimit' : 'full')
    if (failure.error === 'fileTooLarge' && failure.maxMb) {
      return tLimits('fileTooLarge', { max: format.number(failure.maxMb) })
    }
    return t(`errors.${failure.error}`)
  }
}

/** Says so only when the plan's (or the agency pool's) room is running out. */
function QuotaNotice({ quota }: { quota: KnowledgeQuota }) {
  const t = useTranslations('knowledgeLimits')
  // The tighter limit is the one that matters
  const agencyTighter =
    quota.org_limit !== null && (quota.limit === null || quota.org_limit - (quota.org_used ?? 0) < quota.limit - quota.used)
  const used = agencyTighter ? (quota.org_used ?? 0) : quota.used
  const limit = agencyTighter ? quota.org_limit : quota.limit
  if (limit === null) return null
  const level = quota.available === 0 ? 'full' : usageLevel(limit === 0 ? 100 : (used * 100) / limit)
  if (level === 'ok') return null
  const full = level === 'full'
  return (
    <p
      role="status"
      className={cn(
        'flex items-center gap-2 rounded-lg px-3 py-2 text-sm',
        full ? 'bg-destructive-fill text-destructive-fill-foreground' : 'bg-warning-solid/10 text-warning'
      )}
    >
      <AlertTriangle className="size-4 shrink-0" />
      {t(full ? 'full' : 'nearlyFull')}
    </p>
  )
}

export function UploadCard({ clientId, quota }: { clientId: string; quota: KnowledgeQuota | null }) {
  const t = useTranslations('knowledge')
  const tLimits = useTranslations('knowledgeLimits')
  const format = useFormatter()
  const failureMessage = useFailureMessage()
  const maxMb = Math.min(quota?.max_file_size_mb ?? MAX_KNOWLEDGE_FILE_SIZE_MB, MAX_KNOWLEDGE_FILE_SIZE_MB)
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [upload, setUpload] = useState<UploadState>(null)
  const [dragging, setDragging] = useState(false)

  async function handleFile(file: File | undefined) {
    if (!file || upload) return

    // Mirror the server checks for instant feedback; the server re-validates
    if (!knowledgeFileType(file.name)) return toast.error(t('errors.unsupportedType'))
    if (file.size === 0) return toast.error(t('errors.emptyFile'))
    if (file.size > maxMb * 1024 * 1024) return toast.error(tLimits('fileTooLarge', { max: format.number(maxMb) }))

    setUpload({ name: file.name, progress: 0 })
    const result = await uploadWithProgress(`/api/knowledge/upload/${clientId}`, file, (progress) =>
      setUpload({ name: file.name, progress })
    )
    setUpload(null)
    if (inputRef.current) inputRef.current.value = ''

    if (result.ok) {
      toast.success(t('toast.uploaded'))
      router.refresh()
    } else {
      toast.error(failureMessage(result))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('upload.title')}</CardTitle>
        <CardDescription>{t('upload.description')}</CardDescription>
      </CardHeader>
      <CardContent className="grid gap-4">
        {quota && <QuotaNotice quota={quota} />}
        <div
          onDragOver={(e) => {
            e.preventDefault()
            if (!upload) setDragging(true)
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(e) => {
            e.preventDefault()
            setDragging(false)
            handleFile(e.dataTransfer.files[0])
          }}
          className={cn(
            'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center',
            dragging ? 'border-primary bg-primary/5' : 'border-border'
          )}
        >
          {upload ? (
            <div className="grid w-full max-w-sm gap-2">
              <p className="truncate text-sm font-medium">{upload.name}</p>
              <Progress value={upload.progress} aria-label={t('upload.uploading')} />
              <p className="text-xs text-muted-foreground">
                {upload.progress < 100
                  ? t('upload.progress', { percent: upload.progress })
                  : t('upload.finishing')}
              </p>
            </div>
          ) : (
            <>
              <UploadCloud className="size-10 text-muted-foreground" />
              <div>
                <p className="text-sm font-medium">{t('upload.dropHere')}</p>
                <p className="text-xs text-muted-foreground">{t('upload.limits', { max: format.number(maxMb) })}</p>
              </div>
              <Button type="button" variant="outline" onClick={() => inputRef.current?.click()}>
                <FileUp data-icon="inline-start" />
                {t('upload.choose')}
              </Button>
            </>
          )}
          <input
            ref={inputRef}
            type="file"
            accept={KNOWLEDGE_ACCEPT}
            className="sr-only"
            tabIndex={-1}
            aria-hidden
            onChange={(e) => handleFile(e.target.files?.[0])}
          />
        </div>
      </CardContent>
    </Card>
  )
}
