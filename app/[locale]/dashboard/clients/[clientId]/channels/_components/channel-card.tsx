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
import { deleteChannelAction, setCommentRepliesAction, subscribeWhatsappAction, toggleChannelActive } from '@/lib/actions/channels'
import { retryWhatsAppConnect } from '@/lib/actions/whatsapp-connect'
import { SYNC_WINDOW_MS } from '@/lib/meta/coexistence'
import { WHATSAPP_CONNECT_MESSAGES } from '@/lib/types/whatsapp-connect'
import type { SubscriptionState } from '@/lib/meta/subscription'
import { COMMENT_CHANNEL_TYPES, type Channel } from '@/lib/types/channels'
import { ChannelIcon } from '@/components/channel-icon'
import { embedCode } from './channel-meta'

/**
 * A WhatsApp channel's subscription state, as the page read it from Meta.
 * Four states that never collapse: linked; not linked (messages will not
 * arrive: the one every other indicator hid on 2026-10-26); not set up on our
 * side; and the check itself failed (not knowing is not knowing it is
 * broken). Badge tone and text per state.
 */
/**
 * Channels that talk to people on a Meta account. Turning one on asks first:
 * it is the moment a bot starts answering real people (a connected Meta
 * channel is created paused, .scratch/messenger-instagram-design.md §12).
 * WhatsApp too, now that a clinic connects it itself and it starts paused.
 */
const META_TYPES: readonly Channel['type'][] = ['facebook', 'instagram', 'whatsapp']

const SUBSCRIPTION_VIEW = {
  subscribed: { key: 'subscribed', tone: 'positive' },
  not_subscribed: { key: 'notSubscribed', tone: 'critical' },
  not_configured: { key: 'notConfigured', tone: 'warning' },
  failed: { key: 'failed', tone: 'quiet' },
} as const

export function ChannelCard({
  channel,
  clientName,
  canManage,
  appOrigin,
  subscription = null,
}: {
  channel: Channel
  /** For the turn-on confirmation of a Meta channel */
  clientName: string
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
  const [switchOnOpen, setSwitchOnOpen] = useState(false)
  const [isSettingComments, startComments] = useTransition()
  const isMeta = META_TYPES.includes(channel.type)
  const takesComments = COMMENT_CHANNEL_TYPES.includes(channel.type)

  const snippet =
    channel.type === 'website' ? embedCode(appOrigin, channel.id) : null

  function handleToggle(checked: boolean) {
    // A Meta channel is turned on only through the confirmation
    if (checked && isMeta) {
      setSwitchOnOpen(true)
      return
    }
    toggle(checked)
  }

  function toggle(checked: boolean) {
    startToggle(async () => {
      const result = await toggleChannelActive(channel.id, checked)
      if (result.ok) toast.success(checked ? t('toast.activated') : t('toast.deactivated'))
      else toast.error(t(`errors.${result.error}`))
      setSwitchOnOpen(false)
    })
  }

  // COEXISTENCE: the number is on the WhatsApp Business app too. Its two
  // one-shot imports are due within 24 hours of onboarding; past that, a state
  // still waiting is shown as missed (nothing else will ever change it)
  const coexistence = channel.whatsapp_mode === 'coexistence'
  const windowOpen = !!channel.coexistence_onboarded_at && Date.now() - new Date(channel.coexistence_onboarded_at).getTime() < SYNC_WINDOW_MS
  const shownSync = (state: Channel['history_sync']) => (!windowOpen && (state === 'not_requested' || state === 'request_failed') ? 'window_missed' : state)
  const historyState = coexistence ? shownSync(channel.history_sync) : null
  const contactsState = coexistence ? shownSync(channel.contacts_sync) : null
  const canRetrySync = canManage && windowOpen && (channel.history_sync === 'request_failed' || channel.contacts_sync === 'request_failed')
  const [isRetryingSync, startRetrySync] = useTransition()

  function handleRetrySync() {
    startRetrySync(async () => {
      const result = await retryWhatsAppConnect(channel.client_id, channel.id)
      if (result.ok) toast.success(t(WHATSAPP_CONNECT_MESSAGES[result.status]))
      else toast.error(t(WHATSAPP_CONNECT_MESSAGES[result.status]))
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

  function handleCommentReplies(checked: boolean) {
    startComments(async () => {
      const result = await setCommentRepliesAction(channel.id, checked)
      if (!result.ok) toast.error(t(`errors.${result.error}`))
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
            <ChannelIcon type={channel.type} surface="account" className="size-4" />
          </div>
          <div className="min-w-0">
            <CardTitle dir="auto" className="truncate">{channel.name}</CardTitle>
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
        {isMeta && !channel.is_active && channel.connection_notice !== 'removed_by_business' && (
          <p className="text-sm text-muted-foreground">{t('channel.paused.description')}</p>
        )}
        {channel.connection_notice === 'removed_by_business' && <p className="text-sm text-destructive">{t('whatsapp.card.removedByBusiness')}</p>}
        {channel.connection_notice === 'name_pending' && <p className="text-sm text-muted-foreground">{t('whatsapp.card.namePending')}</p>}

        {coexistence && (
          <div className="grid gap-1.5 rounded-lg border p-3 text-sm">
            <div>
              <Badge variant="outline">{t('whatsapp.coexistence.card.badge')}</Badge>
            </div>
            <p className="text-muted-foreground">{t('whatsapp.coexistence.card.mode')}</p>
            {/* Not a fault: Meta opens no reply window for chats from before onboarding */}
            <p className="text-muted-foreground">{t('whatsapp.coexistence.card.firstMessage')}</p>
            {channel.coexistence_offboarded_at && <p className="text-destructive">{t('whatsapp.coexistence.card.offboarded')}</p>}
            {historyState && (
              <p className={historyState === 'request_failed' || historyState === 'window_missed' ? 'text-destructive' : 'text-muted-foreground'}>
                {t(`whatsapp.coexistence.card.history.${historyState}`, { progress: channel.history_sync_progress ?? 0, count: channel.history_imported ?? 0 })}
              </p>
            )}
            {(contactsState === 'request_failed' || contactsState === 'window_missed') && (
              <p className="text-destructive">{t(`whatsapp.coexistence.card.contacts.${contactsState}`)}</p>
            )}
            {canRetrySync && (
              <div>
                <Button variant="outline" size="sm" onClick={handleRetrySync} disabled={isRetryingSync}>
                  {isRetryingSync ? tCommon('loading') : t('whatsapp.coexistence.card.retry')}
                </Button>
              </div>
            )}
          </div>
        )}

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

        {takesComments && canManage && (
          <div className="flex items-start justify-between gap-4 border-t pt-4">
            <div className="grid min-w-0 gap-1">
              <label htmlFor={`comments-${channel.id}`} className="text-sm font-medium">
                {t('comments.label')}
              </label>
              <p className="text-sm text-muted-foreground">{t('comments.description')}</p>
              {/* Who last changed it, stamped by the database; nothing when a script did */}
              {channel.comment_replies_changed_by_name && channel.comment_replies_changed_at && (
                <p className="text-xs text-muted-foreground">
                  {t(channel.comment_replies_enabled ? 'comments.turnedOn' : 'comments.turnedOff', {
                    name: channel.comment_replies_changed_by_name,
                    date: format.dateTime(new Date(channel.comment_replies_changed_at), { dateStyle: 'medium' }),
                  })}
                </p>
              )}
            </div>
            <Switch
              id={`comments-${channel.id}`}
              checked={!!channel.comment_replies_enabled}
              onCheckedChange={handleCommentReplies}
              disabled={isSettingComments}
            />
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

            {isMeta && (
              <AlertDialog open={switchOnOpen} onOpenChange={(next) => !isToggling && setSwitchOnOpen(next)}>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>{t('channel.switchOn.confirm.title')}</AlertDialogTitle>
                    <AlertDialogDescription>{t('channel.switchOn.confirm.description', { client: clientName })}</AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel disabled={isToggling}>{tCommon('cancel')}</AlertDialogCancel>
                    <AlertDialogAction
                      onClick={(e) => {
                        // Keep the dialog open until the server responds
                        e.preventDefault()
                        toggle(true)
                      }}
                      disabled={isToggling}
                    >
                      {isToggling ? tCommon('loading') : t('channel.switchOn.confirm.button')}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            )}

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
                    {coexistence && <span className="mt-2 block font-medium text-destructive">{t('whatsapp.coexistence.card.deleteWarning')}</span>}
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
