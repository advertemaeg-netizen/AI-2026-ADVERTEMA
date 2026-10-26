'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Check, Copy, Link2, Trash2 } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { deleteChannelAction, subscribeWhatsappAction, toggleChannelActive } from '@/lib/actions/channels'
import type { SubscriptionState } from '@/lib/meta/subscription'
import type { Channel } from '@/lib/types/channels'
import { CHANNEL_ICONS } from '@/components/channel-icon'
import { embedCode } from './channel-meta'

/**
 * A WhatsApp channel's subscription state, as the page read it from Meta.
 * Four states that never collapse: linked; not linked (messages will not
 * arrive: the one every other indicator hid on 2026-10-26); not set up on our
 * side; and the check itself failed (not knowing is not knowing it is
 * broken). Badge tone and text per state.
 */
const SUBSCRIPTION_VIEW = {
  subscribed: { key: 'subscribed', tone: 'positive' },
  not_subscribed: { key: 'notSubscribed', tone: 'critical' },
  not_configured: { key: 'notConfigured', tone: 'warning' },
  failed: { key: 'failed', tone: 'quiet' },
} as const

export function ChannelCard({
  channel,
  canManage,
  appOrigin,
  subscription = null,
}: {
  channel: Channel
  canManage: boolean
  appOrigin: string
  /** WhatsApp channels only: the WABA's subscription to our app, read by the page */
  subscription?: SubscriptionState | null
}) {
  const t = useTranslations('channels')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const [isToggling, startToggle] = useTransition()
  const [isDeleting, startDelete] = useTransition()
  const [deleteOpen, setDeleteOpen] = useState(false)
  const [copied, setCopied] = useState(false)
  const [isLinking, startLink] = useTransition()
  const [subscriptionNow, setSubscriptionNow] = useState(subscription)

  const Icon = CHANNEL_ICONS[channel.type]
  const snippet =
    channel.type === 'website' ? embedCode(appOrigin, channel.id) : null

  function handleToggle(checked: boolean) {
    startToggle(async () => {
      const result = await toggleChannelActive(channel.id, checked)
      if (result.ok) toast.success(checked ? t('toast.activated') : t('toast.deactivated'))
      else toast.error(t(`errors.${result.error}`))
    })
  }

  function handleDelete(e: React.MouseEvent) {
    // Keep the dialog open until the server responds
    e.preventDefault()
    startDelete(async () => {
      const result = await deleteChannelAction(channel.id)
      if (result.ok) {
        toast.success(t('toast.deleted'))
        setDeleteOpen(false)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  // The connect step (subscribeApp): the state shown is the one Meta reads back after it
  function handleLink() {
    startLink(async () => {
      const result = await subscribeWhatsappAction(channel.id)
      if (result.kind === 'notFound' || result.kind === 'impersonating') {
        toast.error(t(`errors.${result.kind === 'impersonating' ? 'impersonating' : 'notFound'}`))
        return
      }
      setSubscriptionNow(result)
      if (result.kind === 'subscribed') toast.success(t('whatsapp.subscribed.description'))
      else toast.error(t(`whatsapp.${SUBSCRIPTION_VIEW[result.kind].key}.description`))
    })
  }

  async function handleCopy() {
    if (!snippet) return
    try {
      await navigator.clipboard.writeText(snippet)
      setCopied(true)
      toast.success(t('toast.copied'))
      setTimeout(() => setCopied(false), 2000)
    } catch {
      toast.error(t('errors.copyFailed'))
    }
  }

  return (
    // Lifts on hover; overflow-visible so the bloom (a pseudo-element) is not clipped
    <Card className="lift overflow-visible">
      <CardHeader>
        <div className="flex items-center gap-3">
          <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-muted">
            <Icon className="size-4" />
          </div>
          <div className="min-w-0">
            <CardTitle className="truncate">{channel.name}</CardTitle>
            <CardDescription>
              {t(`types.${channel.type}`)} ·{' '}
              {format.dateTime(new Date(channel.created_at), { dateStyle: 'medium' })}
            </CardDescription>
          </div>
        </div>
        <CardAction>
          <Badge variant={channel.is_active ? 'default' : 'secondary'}>
            {channel.is_active ? t('status.active') : t('status.inactive')}
          </Badge>
        </CardAction>
      </CardHeader>

      <CardContent className="grid gap-4">
        {subscriptionNow && (
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex min-w-0 items-center gap-2">
              <Badge variant={SUBSCRIPTION_VIEW[subscriptionNow.kind].tone}>{t(`whatsapp.${SUBSCRIPTION_VIEW[subscriptionNow.kind].key}.badge`)}</Badge>
              <p className="text-sm text-muted-foreground">{t(`whatsapp.${SUBSCRIPTION_VIEW[subscriptionNow.kind].key}.description`)}</p>
            </div>
            {canManage && subscriptionNow.kind === 'not_subscribed' && (
              <Button variant="outline" size="sm" onClick={handleLink} disabled={isLinking}>
                <Link2 data-icon="inline-start" />
                {isLinking ? tCommon('loading') : t('whatsapp.link')}
              </Button>
            )}
          </div>
        )}

        {snippet && (
          <div className="grid gap-2">
            <div className="flex items-center justify-between gap-2">
              <p className="text-sm font-medium">{t('embed.title')}</p>
              <Button variant="outline" size="sm" onClick={handleCopy}>
                {copied ? <Check data-icon="inline-start" /> : <Copy data-icon="inline-start" />}
                {copied ? t('embed.copied') : t('embed.copy')}
              </Button>
            </div>
            <pre
              dir="ltr"
              className="overflow-x-auto rounded-lg bg-muted p-3 text-start font-mono text-xs leading-relaxed"
            >
              <code>{snippet}</code>
            </pre>
            <p className="text-xs text-muted-foreground">{t('embed.hint')}</p>
          </div>
        )}

        {canManage && (
          <div className="flex items-center justify-between gap-4 border-t pt-4">
            <label className="flex items-center gap-2 text-sm">
              <Switch
                checked={channel.is_active}
                onCheckedChange={handleToggle}
                disabled={isToggling}
              />
              {t('toggleLabel')}
            </label>

            <AlertDialog open={deleteOpen} onOpenChange={(next) => !isDeleting && setDeleteOpen(next)}>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" size="sm" className="text-destructive hover:text-destructive">
                  <Trash2 data-icon="inline-start" />
                  {tCommon('delete')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>
                    {t('deleteDescription', { name: channel.name })}
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isDeleting}>{tCommon('cancel')}</AlertDialogCancel>
                  <AlertDialogAction
                    variant="destructive"
                    onClick={handleDelete}
                    disabled={isDeleting}
                  >
                    {isDeleting ? tCommon('loading') : tCommon('delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </div>
        )}
      </CardContent>
    </Card>
  )
}
