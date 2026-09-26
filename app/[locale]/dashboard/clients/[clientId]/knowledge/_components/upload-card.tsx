'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { FileUp, UploadCloud } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { cn } from '@/lib/utils'
import {
  KNOWLEDGE_ACCEPT,
  MAX_KNOWLEDGE_FILE_SIZE,
  knowledgeFileType,
  type KnowledgeUploadError,
} from '@/lib/types/knowledge'

type UploadState = { name: string; progress: number } | null

/** POSTs with XMLHttpRequest because fetch can't report upload progress. */
function uploadWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void
): Promise<{ ok: boolean; error?: KnowledgeUploadError }> {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest()
    xhr.open('POST', url)
    xhr.responseType = 'json'
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100))
    }
    xhr.onload = () => {
      const body = xhr.response as { ok?: boolean; error?: KnowledgeUploadError } | null
      resolve(
        xhr.status >= 200 && xhr.status < 300
          ? { ok: true }
          : { ok: false, error: body?.error ?? 'uploadFailed' }
      )
    }
    xhr.onerror = () => resolve({ ok: false, error: 'uploadFailed' })
    const form = new FormData()
    form.append('file', file)
    xhr.send(form)
  })
}

export function UploadCard({ clientId }: { clientId: string }) {
  const t = useTranslations('knowledge')
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [upload, setUpload] = useState<UploadState>(null)
  const [dragging, setDragging] = useState(false)

  async function handleFile(file: File | undefined) {
    if (!file || upload) return

    // Mirror the server checks for instant feedback; the server re-validates
    if (!knowledgeFileType(file.name)) return toast.error(t('errors.unsupportedType'))
    if (file.size === 0) return toast.error(t('errors.emptyFile'))
    if (file.size > MAX_KNOWLEDGE_FILE_SIZE) return toast.error(t('errors.fileTooLarge'))

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
      toast.error(t(`errors.${result.error ?? 'uploadFailed'}`))
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('upload.title')}</CardTitle>
        <CardDescription>{t('upload.description')}</CardDescription>
      </CardHeader>
      <CardContent>
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
                <p className="text-xs text-muted-foreground">{t('upload.limits')}</p>
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
