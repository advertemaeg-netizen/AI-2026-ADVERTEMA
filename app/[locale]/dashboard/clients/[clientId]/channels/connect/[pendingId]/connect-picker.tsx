'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Checkbox } from '@/components/ui/checkbox'
import { Label } from '@/components/ui/label'
import { cancelMetaConnect, completeMetaConnect } from '@/lib/actions/meta-connect'
import {
  CONNECT_STATUS_MESSAGES,
  type ConnectStatus,
  type PickerAvailability,
  type PickerOption,
  type PickerSelection,
  type PickerView,
} from '@/lib/types/meta-connect'

/** Statuses that end the pick: back to the channels page, which shows them */
const LEAVES: readonly ConnectStatus[] = ['connected', 'reconnected', 'connectedMessagesBlocked', 'subscribeFailed', 'expired', 'cancelled']

export function ConnectPicker({ view }: { view: PickerView }) {
  const t = useTranslations('channels')
  const locale = useLocale()
  const router = useRouter()
  const [selection, setSelection] = useState<PickerSelection | null>(null)
  const [isPending, startTransition] = useTransition()

  const channelsPath = `/${locale}/dashboard/clients/${view.clientId}/channels`
  const selectable = (a: PickerAvailability | null | undefined) => a === 'available' || a === 'connected'
  const allUnavailable = view.options.every((o) => !selectable(o.messenger) && !selectable(o.instagram?.availability))
  const ticked = !!selection && (selection.messenger || selection.instagram)

  /** A tick under another Page starts a new pick: one Page at a time */
  function toggle(option: PickerOption, channel: 'messenger' | 'instagram', checked: boolean) {
    setSelection((current) => {
      const base = current?.pageId === option.pageId ? current : { pageId: option.pageId, messenger: false, instagram: false }
      return { ...base, [channel]: checked }
    })
  }

  function confirm() {
    if (!selection || !ticked) return
    startTransition(async () => {
      const result = await completeMetaConnect(view.pendingId, view.clientId, selection)
      if (LEAVES.includes(result.status)) {
        router.push(`${channelsPath}?connect=${result.status}`)
        router.refresh()
        return
      }
      toast.error(t(CONNECT_STATUS_MESSAGES[result.status]))
      router.refresh()
    })
  }

  function cancel() {
    startTransition(async () => {
      await cancelMetaConnect(view.pendingId, view.clientId)
      router.push(`${channelsPath}?connect=cancelled`)
    })
  }

  return (
    <div className="grid max-w-2xl gap-4">
      {allUnavailable && <p className="text-sm text-destructive">{t('picker.allUnavailable')}</p>}

      {view.options.map((option) => {
        const checked = (channel: 'messenger' | 'instagram') => selection?.pageId === option.pageId && selection[channel]
        // A Page the clinic did not offer is never shown as a Page: only its Instagram account is a choice
        const title = option.messenger !== null ? option.pageName : option.instagram?.username ? `@${option.instagram.username}` : option.pageName
        return (
          <Card key={option.pageId}>
            <CardHeader>
              <CardTitle dir="auto">{title}</CardTitle>
              {option.messenger !== null && (
                <p className="text-sm text-muted-foreground" dir="auto">
                  {option.instagram ? t('picker.linkedInstagram', { username: option.instagram.username ?? '' }) : t('picker.noInstagram')}
                </p>
              )}
            </CardHeader>
            <CardContent className="grid gap-3">
              {option.messenger !== null && (
                <ChannelChoice
                  id={`${option.pageId}-messenger`}
                  label={t('picker.channel.messenger')}
                  availability={option.messenger}
                  checked={checked('messenger')}
                  disabled={isPending}
                  onChange={(value) => toggle(option, 'messenger', value)}
                />
              )}
              {option.instagram && (
                <ChannelChoice
                  id={`${option.pageId}-instagram`}
                  label={t('picker.channel.instagram')}
                  availability={option.instagram.availability}
                  checked={checked('instagram')}
                  disabled={isPending}
                  onChange={(value) => toggle(option, 'instagram', value)}
                />
              )}
            </CardContent>
          </Card>
        )
      })}

      <div className="flex flex-wrap items-center gap-3">
        <Button onClick={confirm} disabled={!ticked || isPending}>
          {t('picker.confirm')}
        </Button>
        <Button variant="outline" onClick={cancel} disabled={isPending}>
          {t('picker.cancel')}
        </Button>
        {!ticked && !allUnavailable && <p className="text-xs text-muted-foreground">{t('picker.nothingSelected')}</p>}
      </div>
    </div>
  )
}

function ChannelChoice({
  id,
  label,
  availability,
  checked,
  disabled,
  onChange,
}: {
  id: string
  label: string
  availability: PickerAvailability
  checked: boolean
  disabled: boolean
  onChange: (checked: boolean) => void
}) {
  const t = useTranslations('channels')
  const refused = availability === 'otherClient'
  return (
    <div className="grid gap-1">
      <div className="flex items-center gap-2">
        <Checkbox id={id} checked={checked} disabled={disabled || refused} onCheckedChange={(value) => onChange(value === true)} />
        <Label htmlFor={id}>{label}</Label>
        {availability === 'connected' && <Badge variant="secondary">{t('picker.alreadyConnected.badge')}</Badge>}
      </div>
      {availability === 'connected' && <p className="ps-6 text-xs text-muted-foreground">{t('picker.alreadyConnected.description')}</p>}
      {refused && <p className="ps-6 text-xs text-destructive">{t('connect.accountOnOtherClient')}</p>}
    </div>
  )
}
