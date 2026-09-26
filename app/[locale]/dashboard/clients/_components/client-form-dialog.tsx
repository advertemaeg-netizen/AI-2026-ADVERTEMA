'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { createClientAction, updateClientAction } from '@/lib/actions/clients'
import {
  CLIENT_STATUSES,
  type Client,
  type ClientActionResult,
  type ClientField,
  type ClientFieldError,
} from '@/lib/types/clients'

type Props =
  | { mode: 'create'; client?: undefined; open?: undefined; onOpenChange?: undefined }
  | { mode: 'edit'; client: Client; open: boolean; onOpenChange: (open: boolean) => void }

export function ClientFormDialog({ mode, client, open, onOpenChange }: Props) {
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
  const [internalOpen, setInternalOpen] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [fieldErrors, setFieldErrors] = useState<Partial<Record<ClientField, ClientFieldError>>>({})

  const isOpen = open ?? internalOpen

  function setOpen(next: boolean) {
    if (isPending) return
    if (!next) setFieldErrors({})
    if (onOpenChange) onOpenChange(next)
    else setInternalOpen(next)
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const formData = new FormData(e.currentTarget)

    startTransition(async () => {
      const result: ClientActionResult =
        mode === 'create'
          ? await createClientAction(formData)
          : await updateClientAction(client.id, formData)

      if (result.ok) {
        toast.success(mode === 'create' ? t('toast.created') : t('toast.updated'))
        setFieldErrors({})
        if (onOpenChange) onOpenChange(false)
        else setInternalOpen(false)
        return
      }

      setFieldErrors(result.fieldErrors ?? {})
      if (result.error !== 'validation') toast.error(t(`errors.${result.error}`))
    })
  }

  function fieldError(field: ClientField) {
    const code = fieldErrors[field]
    if (!code) return null
    return (
      <p id={`${field}-error`} className="text-xs text-destructive">
        {t(`fieldErrors.${code}`)}
      </p>
    )
  }

  return (
    <Dialog open={isOpen} onOpenChange={setOpen}>
      {mode === 'create' && (
        <DialogTrigger asChild>
          <Button>
            <Plus data-icon="inline-start" />
            {t('add')}
          </Button>
        </DialogTrigger>
      )}
      <DialogContent className="sm:max-w-lg">
        {/* key remounts the form so edits start from the saved values each time */}
        <form key={isOpen ? 'open' : 'closed'} onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{mode === 'create' ? t('addTitle') : t('editTitle')}</DialogTitle>
            <DialogDescription>
              {mode === 'create' ? t('addDescription') : t('editDescription')}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="name">{t('fields.name')} *</Label>
            <Input
              id="name"
              name="name"
              defaultValue={client?.name}
              placeholder={t('placeholders.name')}
              maxLength={100}
              required
              autoFocus
              aria-invalid={!!fieldErrors.name}
              aria-describedby={fieldErrors.name ? 'name-error' : undefined}
            />
            {fieldError('name')}
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="slug">{t('fields.slug')}</Label>
              <Input
                id="slug"
                name="slug"
                dir="ltr"
                defaultValue={client?.slug}
                placeholder={t('placeholders.slug')}
                maxLength={60}
                aria-invalid={!!fieldErrors.slug}
                aria-describedby={fieldErrors.slug ? 'slug-error' : 'slug-hint'}
              />
              {fieldError('slug') ?? (
                <p id="slug-hint" className="text-xs text-muted-foreground">
                  {t('hints.slug')}
                </p>
              )}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="industry">{t('fields.industry')}</Label>
              <Input
                id="industry"
                name="industry"
                defaultValue={client?.industry ?? ''}
                placeholder={t('placeholders.industry')}
                maxLength={100}
                aria-invalid={!!fieldErrors.industry}
                aria-describedby={fieldErrors.industry ? 'industry-error' : undefined}
              />
              {fieldError('industry')}
            </div>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="status">{t('fields.status')}</Label>
              <Select name="status" defaultValue={client?.status ?? 'active'}>
                <SelectTrigger id="status" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {CLIENT_STATUSES.map((status) => (
                    <SelectItem key={status} value={status}>
                      {t(`status.${status}`)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {fieldError('status')}
            </div>

            <div className="grid gap-2">
              <Label htmlFor="logo_url">{t('fields.logoUrl')}</Label>
              <Input
                id="logo_url"
                name="logo_url"
                type="url"
                dir="ltr"
                defaultValue={client?.logo_url ?? ''}
                placeholder="https://"
                aria-invalid={!!fieldErrors.logo_url}
                aria-describedby={fieldErrors.logo_url ? 'logo_url-error' : undefined}
              />
              {fieldError('logo_url')}
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="description">{t('fields.description')}</Label>
            <Textarea
              id="description"
              name="description"
              defaultValue={client?.description ?? ''}
              placeholder={t('placeholders.description')}
              maxLength={1000}
              rows={3}
              aria-invalid={!!fieldErrors.description}
              aria-describedby={fieldErrors.description ? 'description-error' : undefined}
            />
            {fieldError('description')}
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isPending}>
                {tCommon('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isPending}>
              {isPending ? tCommon('loading') : tCommon('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
