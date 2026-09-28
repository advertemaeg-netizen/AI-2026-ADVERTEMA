'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { FileUp, UploadCloud } from 'lucide-react'
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

/** The failure as a sentence, with the numbers the route sent back. */
function useFailureMessage() {
  const t = useTranslations('knowledge')
  const tLimits = useTranslations('knowledgeLimits')
  const format = useFormatter()
  return (failure: KnowledgeUploadFailure) => {
    if (failure.error === 'chunkLimit') {
      return failure.chunks && failure.available !== undefined
        ? tLimits('chunkLimit', { chunks: format.number(failure.chunks), available: format.number(failure.available) })
        : tLimits('full')
    }
    if (failure.error === 'fileTooLarge' && failure.maxMb) {
      return tLimits('fileTooLarge', { max: format.number(failure.maxMb) })
    }
    return t(`errors.${failure.error}`)
  }
}

/** Chunks used against the plan (and the agency's pool), as a bar. */
function QuotaBar({ quota }: { quota: KnowledgeQuota }) {
  const t = useTranslations('knowledgeLimits')
  const format = useFormatter()
  // The tighter limit is the one that matters
  const agencyTighter =
    quota.org_limit !== null && (quota.limit === null || quota.org_limit - (quota.org_used ?? 0) < quota.limit - quota.used)
  const used = agencyTighter ? (quota.org_used ?? 0) : quota.used
  const limit = agencyTighter ? quota.org_limit : quota.limit
  if (limit === null) {
    return <p className="text-sm text-muted-foreground">{t('usageUnlimited', { used: format.number(used) })}</p>
  }
  const percentage = limit === 0 ? 100 : (used * 100) / limit
  const level = usageLevel(percentage)
  return (
    <div className="grid gap-1.5">
      <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
        <span className="font-medium">
          {t(agencyTighter ? 'agencyUsage' : 'usage', { used: format.number(used), limit: format.number(limit) })}
        </span>
        <span className="text-muted-foreground">{t('available', { available: format.number(quota.available ?? 0) })}</span>
      </div>
      <Progress
        value={Math.min(percentage, 100)}
        aria-label={t('title')}
        className={cn(
          'h-2',
          level === 'warning' && '[&_[data-slot=progress-indicator]]:bg-amber-500',
          level === 'critical' && '[&_[data-slot=progress-indicator]]:bg-orange-600',
          level === 'full' && '[&_[data-slot=progress-indicator]]:bg-destructive'
        )}
      />
    </div>
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
        {quota && <QuotaBar quota={quota} />}
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
            'flex flex-col items-center gap-3 rounded-xl border-2 border-dashed px-6 py-10 text-center transition-colors',
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
