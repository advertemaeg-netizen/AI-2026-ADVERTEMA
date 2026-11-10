'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, Bot, MessageSquareQuote, PanelRight, SendHorizontal, UserRoundCheck } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { Sheet, SheetContent, SheetHeader, SheetTitle, SheetTrigger } from '@/components/ui/sheet'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { ChannelIcon } from '@/components/channel-icon'
import { RelativeTime } from '@/components/relative-time'
import { cn } from '@/lib/utils'
import {
  assignConversation,
  retryAgentMessage,
  sendAgentMessage,
  setConversationAutoReply,
  updateConversationStatus,
} from '@/lib/actions/conversations'
import {
  CONVERSATION_STATUSES,
  REPLY_LIMITS,
  REPLY_WINDOW_MS,
  RETRYABLE_FAILURES,
  fitsChannel,
  isStuck,
  type ConversationDetail,
  type ConversationStatus,
  type Message,
  type ReplyAvailability,
  type ReplyBlock,
  type SendFailure,
  type TeamMember,
} from '@/lib/types/conversations'
import type { LeadVisit } from '@/lib/types/leads'
import { commentAnchor, type ConversationOrigin } from '@/lib/types/comments'
import { ContactAvatar, StatusBadge, useChannelName, useContactLabel } from '../../_components/conversation-bits'
import { LeadVisitsList } from '../../../leads/_components/lead-visits-list'

const UNASSIGNED = 'unassigned'

/**
 * A message added, or a newer view of one already shown. The send's final
 * state can reach the page (the action's answer) before Realtime delivers the
 * 'sending' it passed through: a 'sending' from the same attempt never
 * overwrites a state that came after it. A "send again" is a new attempt
 * (send.at), so its 'sending' does.
 */
function upsertMessage(list: Message[], message: Message) {
  const current = list.find((m) => m.id === message.id)
  if (!current) return [...list, message].sort((a, b) => a.created_at.localeCompare(b.created_at))
  const stale =
    message.send?.state === 'sending' && current.send && current.send.state !== 'sending' && (current.send.at ?? null) === (message.send.at ?? null)
  if (stale) return list
  return list.map((m) => (m.id === message.id ? { ...m, ...message } : m))
}

/** A Realtime row: the send state and a bot reply's failure, out of its metadata */
function fromRow(row: Record<string, unknown>): Message {
  const metadata = (row.metadata ?? null) as { send?: Message['send']; delivery?: Message['delivery'] } | null
  return {
    id: row.id as string,
    conversation_id: row.conversation_id as string,
    role: row.role as Message['role'],
    content: row.content as string,
    sender_id: (row.sender_id ?? null) as string | null,
    created_at: row.created_at as string,
    send: metadata?.send ?? null,
    delivery: metadata?.delivery ?? null,
  }
}

const isReaction = (row: Record<string, unknown>) => {
  const metadata = (row.metadata ?? null) as Record<string, unknown> | null
  return metadata?.whatsapp_type === 'reaction' || metadata?.messenger_type === 'reaction' || metadata?.instagram_type === 'reaction'
}

/** A bot reply marked undelivered before failures carried a reason: its kind, as a reason */
const LEGACY_FAILURE: Record<string, SendFailure> = { outside_window: 'outside_window', not_configured: 'disconnected' }

/** Why an outbound message did not reach the person, or null when it did (or is on its way) */
function failureOf(message: Message, now: number): SendFailure | 'stuck' | null {
  if (message.role !== 'agent' && message.role !== 'assistant') return null
  if (isStuck(message, now)) return 'stuck'
  if (message.send?.state === 'failed') return message.send.reason ?? LEGACY_FAILURE[message.delivery?.failed ?? ''] ?? 'refused'
  if (message.delivery?.failed && message.send?.state !== 'sent') return LEGACY_FAILURE[message.delivery.failed] ?? 'refused'
  return null
}

const FAILURE_KEY: Record<SendFailure | 'stuck', string> = {
  outside_window: 'outsideWindow',
  paused: 'paused',
  disconnected: 'disconnected',
  too_long: 'tooLong',
  refused: 'refused',
  stuck: 'stuck',
}

const BLOCK_KEY: Record<ReplyBlock, string> = {
  paused: 'paused',
  disconnected: 'disconnected',
  outside_window: 'outsideWindow',
  comment_thread: 'commentThread',
}

export function ConversationView({
  initialConversation,
  initialMessages,
  reply,
  origin,
  team,
  leads,
  canManage,
  currentUserId,
}: {
  initialConversation: ConversationDetail
  initialMessages: Message[]
  /** Whether the reply box is open, and when the 24-hour window closes (src/lib/agent-reply.ts) */
  reply: ReplyAvailability
  /** Set when the conversation began from a public comment: the line at the top, and the way back to it */
  origin: ConversationOrigin | null
  team: TeamMember[]
  /** Every lead this conversation produced, oldest first */
  leads: LeadVisit[]
  canManage: boolean
  currentUserId: string
}) {
  const t = useTranslations('conversations')
  const tChannels = useTranslations('channels')
  const tClientNav = useTranslations('clientNav')
  const format = useFormatter()
  const contactLabel = useContactLabel()
  const channelName = useChannelName()

  const [conversation, setConversation] = useState(initialConversation)
  const [messages, setMessages] = useState(initialMessages)
  const [draft, setDraft] = useState('')
  const [isSending, startSending] = useTransition()
  const [isUpdating, startUpdating] = useTransition()
  const [isRetrying, startRetrying] = useTransition()
  const endRef = useRef<HTMLDivElement>(null)

  // The window moves on its own: it closes while the page is open, and a
  // new message from the person opens it again
  const onMeta = conversation.channel.type !== 'website' && conversation.thread === 'dm'
  const [windowEndsAt, setWindowEndsAt] = useState(reply.windowEndsAt)
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  const outsideWindow = windowEndsAt ? now >= new Date(windowEndsAt).getTime() : reply.blocked === 'outside_window'
  const blocked: ReplyBlock | null = reply.blocked && reply.blocked !== 'outside_window' ? reply.blocked : onMeta && outsideWindow ? 'outside_window' : null
  const limit = REPLY_LIMITS[conversation.channel.type]
  const tooLong = !fitsChannel(conversation.channel.type, draft.trim())

  const teamById = useMemo(() => new Map(team.map((member) => [member.id, member])), [team])
  const memberName = (id: string | null) => {
    if (!id) return null
    if (id === currentUserId) return t('you')
    const member = teamById.get(id)
    return member ? member.full_name || member.email : t('agent')
  }

  // Live updates: new messages from the visitor / AI / teammates, and
  // status or assignment changes made elsewhere
  useEffect(() => {
    const supabase = createClient()
    const channel = supabase
      .channel(`conversation:${conversation.id}`)
      .on(
        'postgres_changes',
        {
          event: 'INSERT',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversation.id}`,
        },
        (payload) => {
          const row = payload.new as Record<string, unknown>
          setMessages((prev) => upsertMessage(prev, fromRow(row)))
          if (row.role === 'user' && !isReaction(row)) {
            setWindowEndsAt(new Date(new Date(row.created_at as string).getTime() + REPLY_WINDOW_MS).toISOString())
          }
        }
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'messages',
          filter: `conversation_id=eq.${conversation.id}`,
        },
        // A send's state moving: sending → sent or failed, here or in a teammate's inbox
        (payload) => setMessages((prev) => upsertMessage(prev, fromRow(payload.new as Record<string, unknown>)))
      )
      .on(
        'postgres_changes',
        {
          event: 'UPDATE',
          schema: 'public',
          table: 'conversations',
          filter: `id=eq.${conversation.id}`,
        },
        (payload) => {
          const next = payload.new as Partial<ConversationDetail>
          setConversation((prev) => ({
            ...prev,
            status: next.status ?? prev.status,
            assigned_to: next.assigned_to !== undefined ? next.assigned_to : prev.assigned_to,
            contact_name: next.contact_name !== undefined ? next.contact_name : prev.contact_name,
            last_message_at: next.last_message_at ?? prev.last_message_at,
            auto_reply_enabled: next.auto_reply_enabled ?? prev.auto_reply_enabled,
          }))
        }
      )
      .subscribe()

    return () => {
      supabase.removeChannel(channel)
    }
  }, [conversation.id])

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [messages.length])

  function send() {
    const text = draft.trim()
    if (!text || isSending || blocked || tooLong) return

    startSending(async () => {
      const result = await sendAgentMessage(conversation.id, text)
      if (!result.ok) {
        toast.error(t(`errors.${result.error}`))
        return
      }
      setDraft('')
      setMessages((prev) => upsertMessage(prev, result.data))
      // The DB trigger hands the conversation off to humans on agent replies
      setConversation((prev) => ({
        ...prev,
        auto_reply_enabled: false,
        status: prev.status === 'new' ? 'in_progress' : prev.status,
      }))
    })
  }

  function retry(messageId: string) {
    startRetrying(async () => {
      const result = await retryAgentMessage(messageId)
      if (!result.ok) {
        toast.error(t(`errors.${result.error}`))
        return
      }
      setMessages((prev) => upsertMessage(prev, result.data))
    })
  }

  function changeStatus(status: ConversationStatus) {
    const previous = conversation.status
    setConversation((prev) => ({ ...prev, status }))
    startUpdating(async () => {
      const result = await updateConversationStatus(conversation.id, status)
      if (result.ok) {
        toast.success(t('toast.statusUpdated'))
      } else {
        setConversation((prev) => ({ ...prev, status: previous }))
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  function toggleAutoReply(enabled: boolean) {
    const previous = conversation.auto_reply_enabled
    setConversation((prev) => ({ ...prev, auto_reply_enabled: enabled }))
    startUpdating(async () => {
      const result = await setConversationAutoReply(conversation.id, enabled)
      if (result.ok) {
        toast.success(enabled ? t('toast.aiEnabled') : t('toast.aiDisabled'))
      } else {
        setConversation((prev) => ({ ...prev, auto_reply_enabled: previous }))
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  function changeAssignee(value: string) {
    const userId = value === UNASSIGNED ? null : value
    const previous = conversation.assigned_to
    setConversation((prev) => ({ ...prev, assigned_to: userId }))
    startUpdating(async () => {
      const result = await assignConversation(conversation.id, userId)
      if (result.ok) {
        toast.success(userId ? t('toast.assigned') : t('toast.unassigned'))
      } else {
        setConversation((prev) => ({ ...prev, assigned_to: previous }))
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  const contact = contactLabel(conversation)

  const details = (
    <>
    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('panel.contact')}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm">
          <Detail label={t('fields.name')}>{contact}</Detail>
          {conversation.contact_identifier && (
            <Detail label={t('fields.identifier')}>
              <span dir="ltr" className="break-all font-mono text-xs">
                {conversation.contact_identifier}
              </span>
            </Detail>
          )}
          <Detail label={t('fields.startedAt')}>
            {format.dateTime(new Date(conversation.created_at), {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
          </Detail>
          <Detail label={t('fields.lastActivity')}>
            <RelativeTime date={conversation.last_message_at} />
          </Detail>
          <Detail label={t('fields.status')}>
            <StatusBadge status={conversation.status} />
          </Detail>
        </dl>
      </CardContent>
    </Card>

    {leads.length > 0 && (
      <Card size="sm">
        <CardHeader>
          <CardTitle>{t('panel.leads')}</CardTitle>
        </CardHeader>
        <CardContent>
          <LeadVisitsList visits={leads.map((visit, index) => ({ visit, number: index + 1 }))} />
        </CardContent>
      </Card>
    )}

    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('panel.client')}</CardTitle>
      </CardHeader>
      <CardContent>
        <dl className="grid gap-3 text-sm">
          <Detail label={t('fields.clientName')}>
            {canManage ? (
              <Link
                href={`/dashboard/clients/${conversation.client.id}/channels`}
                className="hover:underline"
              >
                {conversation.client.name}
              </Link>
            ) : (
              conversation.client.name
            )}
          </Detail>
          {conversation.client.industry && (
            <Detail label={t('fields.industry')}>{conversation.client.industry}</Detail>
          )}
          <Detail label={t('fields.channel')}>
            <span className="inline-flex items-center gap-1.5">
              <ChannelIcon type={conversation.channel.type} className="size-4" />
              {conversation.channel.name}
              <span className="text-muted-foreground">
                ({tChannels(`types.${conversation.channel.type}`)})
              </span>
            </span>
          </Detail>
        </dl>
      </CardContent>
    </Card>

    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('panel.ai')}</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        <label className="flex items-center justify-between gap-3 text-sm">
          <span className="inline-flex items-center gap-1.5">
            {conversation.auto_reply_enabled ? (
              <Bot className="size-4" />
            ) : (
              <UserRoundCheck className="size-4" />
            )}
            {conversation.auto_reply_enabled ? t('ai.on') : t('ai.off')}
          </span>
          <Switch
            checked={conversation.auto_reply_enabled}
            onCheckedChange={toggleAutoReply}
            disabled={isUpdating}
          />
        </label>
        <p className="text-xs text-muted-foreground">
          {conversation.auto_reply_enabled ? t('ai.onHint') : t('ai.offHint')}
        </p>
      </CardContent>
    </Card>

    <Card size="sm">
      <CardHeader>
        <CardTitle>{t('panel.assignment')}</CardTitle>
      </CardHeader>
      <CardContent>
        {canManage ? (
          <Select
            value={conversation.assigned_to ?? UNASSIGNED}
            onValueChange={changeAssignee}
            disabled={isUpdating}
          >
            <SelectTrigger className="w-full" aria-label={t('fields.assignedTo')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={UNASSIGNED}>{t('unassigned')}</SelectItem>
              {team.map((member) => (
                <SelectItem key={member.id} value={member.id}>
                  {member.id === currentUserId
                    ? `${member.full_name || member.email} (${t('you')})`
                    : member.full_name || member.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : (
          <p className="text-sm">{memberName(conversation.assigned_to) ?? t('unassigned')}</p>
        )}
        {canManage && team.length === 0 && (
          <p className="mt-2 text-xs text-muted-foreground">{t('noTeam')}</p>
        )}
      </CardContent>
    </Card>
    </>
  )

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4 max-md:flex-nowrap max-md:gap-1 max-md:px-1 max-md:py-1">
        <div className="flex min-w-0 items-center gap-3 max-md:flex-1 max-md:gap-2">
          <Button variant="ghost" size="icon-sm" className="max-md:size-11" asChild>
            <Link href="/dashboard/conversations" aria-label={t('backToInbox')}>
              <ArrowLeft className="rtl:rotate-180" />
            </Link>
          </Button>
          <ContactAvatar
            name={conversation.contact_name}
            channelType={conversation.channel.type}
            channelLabel={channelName(conversation.channel.type)}
          />
          <div className="min-w-0">
            <h1 dir="auto" className="truncate font-semibold">{contact}</h1>
            <p className="flex min-w-0 gap-1 text-xs text-muted-foreground">
              <span dir="auto" className="min-w-0 truncate">{conversation.client.name}</span>
              <span aria-hidden>·</span>
              <span dir="auto" className="min-w-0 truncate">{conversation.channel.name}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2 max-md:gap-1">
          <span className="text-sm text-muted-foreground max-md:sr-only">{t('fields.status')}</span>
          <Select
            value={conversation.status}
            onValueChange={(value) => changeStatus(value as ConversationStatus)}
            disabled={isUpdating}
          >
            <SelectTrigger className="w-40 max-md:w-28" aria-label={t('changeStatus')}>
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {CONVERSATION_STATUSES.map((status) => (
                <SelectItem key={status} value={status}>
                  {t(`status.${status}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {/* The side panel is desktop-only; phones and tablets open it as a sheet */}
          <Sheet>
            <SheetTrigger asChild>
              <Button variant="ghost" size="icon" className="size-11 lg:hidden" aria-label={t('panel.open')}>
                <PanelRight className="rtl:-scale-x-100" />
              </Button>
            </SheetTrigger>
            <SheetContent side="end" className="gap-0 p-0" closeLabel={t('panel.close')}>
              <SheetHeader className="border-b">
                <SheetTitle>{t('panel.title')}</SheetTitle>
              </SheetHeader>
              <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-4">{details}</div>
            </SheetContent>
          </Sheet>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_320px]">
        <section className="flex min-h-0 flex-col" aria-label={t('messages')}>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-6 max-md:p-3" role="log" aria-live="polite">
              {origin && (
                // The link back to the comment it began from (comments tab decisions, 2)
                <Link
                  href={origin.commentId ? `/dashboard/comments#${commentAnchor(origin.commentId)}` : '/dashboard/comments'}
                  className="mx-auto flex max-w-full items-center gap-2 rounded-full border border-foreground/40 px-3 py-1 text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-2"
                >
                  <MessageSquareQuote className="size-3.5 shrink-0" aria-hidden />
                  <span className="min-w-0">{t('fromComment')}</span>
                </Link>
              )}
              {messages.length === 0 && (
                <p className="py-12 text-center text-sm text-muted-foreground">{t('noMessages')}</p>
              )}
              {messages.map((message) => (
                <MessageBubble
                  key={message.id}
                  message={message}
                  senderLabel={
                    message.role === 'agent'
                      ? memberName(message.sender_id) ?? t('agent')
                      : message.role === 'assistant'
                        ? t('assistant')
                        : contact
                  }
                  time={format.dateTime(new Date(message.created_at), {
                    dateStyle: 'short',
                    timeStyle: 'short',
                  })}
                  failure={failureOf(message, now)}
                  onRetry={message.role === 'agent' && !isRetrying ? () => retry(message.id) : undefined}
                />
              ))}
              <div ref={endRef} />
            </div>
          </ScrollArea>

          {blocked && (
            <p role="status" className="border-t bg-muted/50 px-4 py-2 text-sm text-muted-foreground max-md:px-2">
              {t(`box.${BLOCK_KEY[blocked]}`)}
              {(blocked === 'paused' || blocked === 'disconnected') && canManage && (
                <>
                  {' '}
                  <Link href={`/dashboard/clients/${conversation.client.id}/channels`} className="underline underline-offset-4">
                    {tClientNav('channels')}
                  </Link>
                </>
              )}
            </p>
          )}
          <form
            className={cn(
              'flex items-end gap-2 p-4 max-md:p-2 max-md:pb-[max(0.5rem,env(safe-area-inset-bottom))]',
              !blocked && 'border-t'
            )}
            onSubmit={(e) => {
              e.preventDefault()
              send()
            }}
          >
            <Textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault()
                  send()
                }
              }}
              placeholder={t('replyPlaceholder')}
              aria-label={t('replyPlaceholder')}
              rows={2}
              // Instagram counts bytes, which the attribute cannot: tooLong says so below
              maxLength={'chars' in limit ? limit.chars : 4000}
              disabled={blocked !== null}
              aria-invalid={tooLong || undefined}
              aria-describedby={tooLong ? 'reply-too-long' : undefined}
              className="max-h-40 min-h-10 resize-none max-md:max-h-32 max-md:min-h-11"
            />
            <Button type="submit" disabled={!draft.trim() || isSending || blocked !== null || tooLong} className="max-md:size-11 max-md:px-0">
              <SendHorizontal data-icon="inline-start" className="rtl:rotate-180" />
              <span className="max-md:sr-only">{isSending ? t('sending') : t('send')}</span>
            </Button>
          </form>
          {tooLong && !blocked && (
            <p id="reply-too-long" className="px-4 pb-2 text-xs text-destructive max-md:px-2">
              {t('fail.tooLong')}
            </p>
          )}
        </section>

        <aside className="hidden min-h-0 space-y-4 overflow-y-auto border-s p-4 lg:block">
          {details}
        </aside>
      </div>
    </div>
  )
}

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function MessageBubble({
  message,
  senderLabel,
  time,
  failure,
  onRetry,
}: {
  message: Message
  senderLabel: string
  time: string
  /** Why it did not reach the person; null when it did or is on its way */
  failure: SendFailure | 'stuck' | null
  /** "Send again", offered on a person's reply whose failure might have passed */
  onRetry?: () => void
}) {
  const t = useTranslations('conversations')
  if (message.role === 'system') {
    return (
      <p className="self-center rounded-full bg-muted px-3 py-1 text-xs text-muted-foreground">
        {message.content}
      </p>
    )
  }

  // Visitor on the start side; our side (AI + human agents) on the end side
  const fromVisitor = message.role === 'user'

  return (
    <div
      className={cn(
        'flex max-w-[80%] flex-col gap-1 max-md:max-w-[88%]',
        // Each message springs in from its own side
        fromVisitor ? 'msg-in-start self-start' : 'msg-in-end self-end items-end'
      )}
    >
      <span className="inline-flex items-center gap-1 text-xs text-muted-foreground">
        {message.role === 'assistant' && <Bot className="size-3.5" />}
        {senderLabel} · {time}
      </span>
      <div
        className={cn(
          'whitespace-pre-wrap break-words rounded-2xl px-3.5 py-2 text-sm',
          fromVisitor && 'rounded-ss-sm bg-muted',
          message.role === 'assistant' && 'rounded-se-sm border bg-background',
          message.role === 'agent' && 'rounded-se-sm bg-primary text-primary-foreground'
        )}
      >
        {message.content}
      </div>
      {failure ? (
        // On the row, so it is still there tomorrow: never only a toast
        <div className="grid max-w-full justify-items-end gap-1 text-end text-xs text-destructive">
          <span className="font-medium">{t('message.failed')}</span>
          <span>{t(`fail.${FAILURE_KEY[failure]}`)}</span>
          {onRetry && RETRYABLE_FAILURES.includes(failure) && (
            <Button type="button" variant="outline" size="sm" onClick={onRetry}>
              {t('message.retry')}
            </Button>
          )}
        </div>
      ) : (
        message.send?.state === 'sending' && <span className="text-xs text-muted-foreground">{t('message.sending')}</span>
      )}
    </div>
  )
}
