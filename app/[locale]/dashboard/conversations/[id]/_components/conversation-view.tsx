'use client'

import { useEffect, useMemo, useRef, useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeft, Bot, SendHorizontal, UserRoundCheck } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { createClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Switch } from '@/components/ui/switch'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
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
  sendAgentMessage,
  setConversationAutoReply,
  updateConversationStatus,
} from '@/lib/actions/conversations'
import {
  CONVERSATION_STATUSES,
  type ConversationDetail,
  type ConversationStatus,
  type Message,
  type TeamMember,
} from '@/lib/types/conversations'
import { ContactAvatar, StatusBadge, useContactLabel } from '../../_components/conversation-bits'

const UNASSIGNED = 'unassigned'

function upsertMessage(list: Message[], message: Message) {
  if (list.some((m) => m.id === message.id)) return list
  return [...list, message].sort((a, b) => a.created_at.localeCompare(b.created_at))
}

export function ConversationView({
  initialConversation,
  initialMessages,
  team,
  canManage,
  currentUserId,
}: {
  initialConversation: ConversationDetail
  initialMessages: Message[]
  team: TeamMember[]
  canManage: boolean
  currentUserId: string
}) {
  const t = useTranslations('conversations')
  const tChannels = useTranslations('channels')
  const format = useFormatter()
  const contactLabel = useContactLabel()

  const [conversation, setConversation] = useState(initialConversation)
  const [messages, setMessages] = useState(initialMessages)
  const [draft, setDraft] = useState('')
  const [isSending, startSending] = useTransition()
  const [isUpdating, startUpdating] = useTransition()
  const endRef = useRef<HTMLDivElement>(null)

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
        (payload) => setMessages((prev) => upsertMessage(prev, payload.new as Message))
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
    if (!text || isSending) return

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

  return (
    <div className="flex h-screen flex-col">
      <header className="flex flex-wrap items-center justify-between gap-3 border-b px-6 py-4">
        <div className="flex min-w-0 items-center gap-3">
          <Button variant="ghost" size="icon-sm" asChild>
            <Link href="/dashboard/conversations" aria-label={t('backToInbox')}>
              <ArrowLeft className="rtl:rotate-180" />
            </Link>
          </Button>
          <ContactAvatar name={conversation.contact_name} channelType={conversation.channel.type} />
          <div className="min-w-0">
            <h1 className="truncate font-semibold">{contact}</h1>
            <p className="truncate text-xs text-muted-foreground">
              {conversation.client.name} · {conversation.channel.name}
            </p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-sm text-muted-foreground">{t('fields.status')}</span>
          <Select
            value={conversation.status}
            onValueChange={(value) => changeStatus(value as ConversationStatus)}
            disabled={isUpdating}
          >
            <SelectTrigger className="w-40" aria-label={t('changeStatus')}>
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
        </div>
      </header>

      <div className="grid min-h-0 flex-1 lg:grid-cols-[1fr_320px]">
        <section className="flex min-h-0 flex-col" aria-label={t('messages')}>
          <ScrollArea className="min-h-0 flex-1">
            <div className="flex flex-col gap-3 p-6" role="log" aria-live="polite">
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
                />
              ))}
              <div ref={endRef} />
            </div>
          </ScrollArea>

          <form
            className="flex items-end gap-2 border-t p-4"
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
              maxLength={4000}
              className="max-h-40 min-h-10 resize-none"
            />
            <Button type="submit" disabled={!draft.trim() || isSending}>
              <SendHorizontal data-icon="inline-start" className="rtl:rotate-180" />
              {isSending ? t('sending') : t('send')}
            </Button>
          </form>
        </section>

        <aside className="hidden min-h-0 space-y-4 overflow-y-auto border-s p-4 lg:block">
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
}: {
  message: Message
  senderLabel: string
  time: string
}) {
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
    <div className={cn('flex max-w-[80%] flex-col gap-1', fromVisitor ? 'self-start' : 'self-end items-end')}>
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
    </div>
  )
}
