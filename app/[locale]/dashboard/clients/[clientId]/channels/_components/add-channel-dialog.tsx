'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Clock, Plus } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
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
import { createChannelAction } from '@/lib/actions/channels'
import { startMetaConnect } from '@/lib/actions/meta-connect'
import { CONNECT_STATUS_MESSAGES } from '@/lib/types/meta-connect'
import { AVAILABLE_CHANNEL_TYPES, CHANNEL_TYPES, type ChannelType } from '@/lib/types/channels'
import { CHANNEL_ICONS } from '@/components/channel-icon'

/** Facebook and Instagram are one login, one card: what to connect is chosen after the return from Meta */
const META_TYPES: readonly ChannelType[] = ['facebook', 'instagram']

export function AddChannelDialog({ clientId, metaConnect = false }: { clientId: string; metaConnect?: boolean }) {
  const t = useTranslations('channels')
  const locale = useLocale()
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [type, setType] = useState<ChannelType>('website')
  const [nameError, setNameError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const available = AVAILABLE_CHANNEL_TYPES.includes(type)
  const meta = metaConnect && META_TYPES.includes(type)

  function handleMetaConnect() {
    startTransition(async () => {
      const result = await startMetaConnect(clientId, locale)
      if (result.ok) {
        window.location.assign(result.url)
        return
      }
      toast.error(t(CONNECT_STATUS_MESSAGES[result.status]))
    })
  }

  function handleOpenChange(next: boolean) {
    if (isPending) return
    setOpen(next)
    if (!next) {
      setType('website')
      setNameError(null)
    }
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    if (!available) return
    const formData = new FormData(e.currentTarget)

    startTransition(async () => {
      const result = await createChannelAction(clientId, formData)
      if (result.ok) {
        toast.success(t('toast.created'))
        setOpen(false)
        setType('website')
        setNameError(null)
        return
      }
      const fieldError = result.fieldErrors?.name
      setNameError(fieldError ? t(`fieldErrors.${fieldError}`) : null)
      if (!fieldError) toast.error(t(`errors.${result.error}`))
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus data-icon="inline-start" />
          {t('add')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form key={open ? 'open' : 'closed'} onSubmit={handleSubmit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('addTitle')}</DialogTitle>
            <DialogDescription>{t('addDescription')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="channel-type">{t('fields.type')}</Label>
            <Select name="type" value={type} onValueChange={(v) => setType(v as ChannelType)}>
              <SelectTrigger id="channel-type" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CHANNEL_TYPES.map((value) => {
                  const Icon = CHANNEL_ICONS[value]
                  return (
                    <SelectItem key={value} value={value}>
                      <Icon />
                      {t(`types.${value}`)}
                      {!AVAILABLE_CHANNEL_TYPES.includes(value) && !(metaConnect && META_TYPES.includes(value)) && (
                        <Badge variant="secondary">{t('comingSoonBadge')}</Badge>
                      )}
                    </SelectItem>
                  )
                })}
              </SelectContent>
            </Select>
          </div>

          {meta ? (
            <div className="grid gap-1 rounded-lg border p-4 text-sm">
              <p className="font-medium">{t('addChannel.meta.title')}</p>
              <p className="text-muted-foreground">{t('addChannel.meta.description')}</p>
            </div>
          ) : available ? (
            <>
              <div className="grid gap-2">
                <Label htmlFor="channel-name">{t('fields.name')} *</Label>
                <Input
                  id="channel-name"
                  name="name"
                  placeholder={t('placeholders.name')}
                  maxLength={100}
                  required
                  aria-invalid={!!nameError}
                  aria-describedby={nameError ? 'channel-name-error' : undefined}
                />
                {nameError && (
                  <p id="channel-name-error" className="text-xs text-destructive">
                    {nameError}
                  </p>
                )}
              </div>
              <p className="text-xs text-muted-foreground">{t('hints.website')}</p>
            </>
          ) : (
            <div className="flex items-start gap-3 rounded-lg border border-dashed p-4 text-sm">
              <Clock className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <div>
                <p className="font-medium">{t('comingSoonTitle')}</p>
                <p className="text-muted-foreground">
                  {t('comingSoonDescription', { type: t(`types.${type}`) })}
                </p>
              </div>
            </div>
          )}

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isPending}>
                {tCommon('cancel')}
              </Button>
            </DialogClose>
            {meta ? (
              <Button type="button" onClick={handleMetaConnect} disabled={isPending}>
                {isPending ? tCommon('loading') : t('addChannel.meta.button')}
              </Button>
            ) : (
              <Button type="submit" disabled={!available || isPending}>
                {isPending ? tCommon('loading') : t('create')}
              </Button>
            )}
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
