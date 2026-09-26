'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ar, enUS } from 'react-day-picker/locale'
import {
  ArrowLeft,
  Bot,
  CalendarClock,
  MessageCircle,
  MessagesSquare,
  Phone,
  Trash2,
  X,
} from 'lucide-react'
import { Link, useRouter } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
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
import { ChannelIcon } from '@/components/channel-icon'
import { RelativeTime } from '@/components/relative-time'
import { telHref, whatsappHref } from '@/lib/phone'
import { deleteLead, updateLead } from '@/lib/actions/leads'
import type { TeamMember } from '@/lib/types/conversations'
import {
  LEAD_STATUSES,
  type LeadDetail,
  type LeadEvent,
  type LeadStatus,
  type LeadUpdateInput,
} from '@/lib/types/leads'
import { LeadStatusBadge } from '../../_components/lead-status-badge'

const DETAIL_FIELDS = ['name', 'phone', 'service_requested', 'budget', 'branch'] as const
type DetailField = (typeof DETAIL_FIELDS)[number]

export function LeadView({
  lead,
  events,
  team,
  canManage,
  currentUserId,
}: {
  lead: LeadDetail
  events: LeadEvent[]
  team: TeamMember[]
  canManage: boolean
  currentUserId: string
}) {
  const t = useTranslations('leads')
  const tCommon = useTranslations('common')
  const tChannels = useTranslations('channels')
  const format = useFormatter()
  const locale = useLocale()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const [details, setDetails] = useState<Record<DetailField, string>>(() =>
    Object.fromEntries(DETAIL_FIELDS.map((f) => [f, lead[f] ?? ''])) as Record<DetailField, string>
  )
  const [notes, setNotes] = useState(lead.notes ?? '')
  const [followUpDay, setFollowUpDay] = useState<Date | undefined>(
    lead.follow_up_date ? new Date(lead.follow_up_date) : undefined
  )
  const [followUpTime, setFollowUpTime] = useState(() => {
    if (!lead.follow_up_date) return '10:00'
    const d = new Date(lead.follow_up_date)
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  })
  const [followUpOpen, setFollowUpOpen] = useState(false)

  const detailsDirty = DETAIL_FIELDS.some((f) => details[f] !== (lead[f] ?? ''))
  const notesDirty = notes !== (lead.notes ?? '')

  function save(data: LeadUpdateInput, successMessage?: string, onSuccess?: () => void) {
    startTransition(async () => {
      const result = await updateLead(lead.id, data)
      if (result.ok) {
        if (successMessage) toast.success(successMessage)
        onSuccess?.()
        router.refresh()
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  // Calling or messaging counts as contact; a brand-new lead moves to "contacted"
  function recordContact() {
    save({
      last_contacted_at: new Date().toISOString(),
      ...(lead.status === 'new' ? { status: 'contacted' as const } : {}),
    })
  }

  function saveFollowUp() {
    if (!followUpDay) return
    const [hours, minutes] = followUpTime.split(':').map(Number)
    const when = new Date(followUpDay)
    when.setHours(hours || 0, minutes || 0, 0, 0)
    save({ follow_up_date: when.toISOString() }, t('toast.followUpSet'), () => setFollowUpOpen(false))
  }

  function handleDelete(e: React.MouseEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await deleteLead(lead.id)
      if (result.ok) {
        toast.success(t('toast.deleted'))
        router.push('/dashboard/leads')
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  const actorName = (actorId: string | null) => {
    if (!actorId) return t('timeline.ai')
    if (actorId === currentUserId) return t('timeline.you')
    const member = team.find((m) => m.id === actorId)
    return member ? member.full_name || member.email : t('timeline.someone')
  }

  const ai = lead.ai_extracted_data
  const channel = lead.conversation?.channel

  return (
    <div className="p-8">
      <Link
        href="/dashboard/leads"
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4 rtl:rotate-180" />
        {t('backToLeads')}
      </Link>

      <div className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="truncate text-3xl font-bold tracking-tight">{lead.name || t('unnamed')}</h1>
            <LeadStatusBadge status={lead.status} />
          </div>
          <p className="mt-1 flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
            {lead.client.name}
            {channel && (
              <>
                {' · '}
                <ChannelIcon type={channel.type} className="size-3.5" />
                {tChannels(`types.${channel.type}`)}
              </>
            )}
            {' · '}
            {t('createdRelative')} <RelativeTime date={lead.created_at} />
          </p>
        </div>

        <div className="flex flex-wrap gap-2">
          {lead.phone && (
            <>
              <Button asChild variant="outline">
                <a href={telHref(lead.phone)} onClick={recordContact}>
                  <Phone data-icon="inline-start" />
                  {t('actions.call')}
                </a>
              </Button>
              <Button asChild className="bg-emerald-600 text-white hover:bg-emerald-700">
                <a href={whatsappHref(lead.phone)} target="_blank" rel="noopener noreferrer" onClick={recordContact}>
                  <MessageCircle data-icon="inline-start" />
                  {t('actions.whatsapp')}
                </a>
              </Button>
            </>
          )}
          {lead.conversation && (
            <Button asChild variant="outline">
              <Link href={`/dashboard/conversations/${lead.conversation.id}`}>
                <MessagesSquare data-icon="inline-start" />
                {t('actions.openConversation')}
              </Link>
            </Button>
          )}
          {canManage && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="ghost" className="text-destructive hover:text-destructive">
                  <Trash2 data-icon="inline-start" />
                  {tCommon('delete')}
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>{t('deleteTitle')}</AlertDialogTitle>
                  <AlertDialogDescription>{t('deleteDescription')}</AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel disabled={isPending}>{tCommon('cancel')}</AlertDialogCancel>
                  <AlertDialogAction variant="destructive" onClick={handleDelete} disabled={isPending}>
                    {tCommon('delete')}
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid gap-6">
          {/* Follow-up */}
          <Card>
            <CardHeader>
              <CardTitle>{t('sections.followUp')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="status">{t('fields.status')}</Label>
                <Select
                  value={lead.status}
                  onValueChange={(status) => save({ status: status as LeadStatus }, t('toast.statusUpdated'))}
                  disabled={isPending}
                >
                  <SelectTrigger id="status" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {LEAD_STATUSES.map((status) => (
                      <SelectItem key={status} value={status}>
                        {t(`status.${status}`)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid gap-2">
                <Label>{t('fields.followUp')}</Label>
                <div className="flex gap-2">
                  <Popover open={followUpOpen} onOpenChange={setFollowUpOpen}>
                    <PopoverTrigger asChild>
                      <Button variant="outline" className="flex-1 justify-start font-normal">
                        <CalendarClock data-icon="inline-start" />
                        {lead.follow_up_date
                          ? format.dateTime(new Date(lead.follow_up_date), {
                              dateStyle: 'medium',
                              timeStyle: 'short',
                            })
                          : t('followUp.pick')}
                      </Button>
                    </PopoverTrigger>
                    <PopoverContent className="w-auto p-2" align="start">
                      <Calendar
                        mode="single"
                        selected={followUpDay}
                        onSelect={setFollowUpDay}
                        locale={locale === 'ar' ? ar : enUS}
                        dir={locale === 'ar' ? 'rtl' : 'ltr'}
                        disabled={{ before: new Date(new Date().setHours(0, 0, 0, 0)) }}
                      />
                      <div className="flex items-center gap-2 border-t p-2">
                        <Label htmlFor="follow-up-time" className="shrink-0">
                          {t('followUp.time')}
                        </Label>
                        <Input
                          id="follow-up-time"
                          type="time"
                          dir="ltr"
                          value={followUpTime}
                          onChange={(e) => setFollowUpTime(e.target.value)}
                          className="w-28"
                        />
                        <Button size="sm" className="ms-auto" onClick={saveFollowUp} disabled={!followUpDay || isPending}>
                          {tCommon('save')}
                        </Button>
                      </div>
                    </PopoverContent>
                  </Popover>
                  {lead.follow_up_date && (
                    <Button
                      variant="ghost"
                      size="icon"
                      aria-label={t('followUp.clear')}
                      onClick={() => {
                        setFollowUpDay(undefined)
                        save({ follow_up_date: null }, t('toast.followUpCleared'))
                      }}
                      disabled={isPending}
                    >
                      <X />
                    </Button>
                  )}
                </div>
              </div>

              <p className="text-xs text-muted-foreground sm:col-span-2">
                {t('fields.lastContacted')}:{' '}
                {lead.last_contacted_at ? <RelativeTime date={lead.last_contacted_at} /> : t('never')}
              </p>
            </CardContent>
          </Card>

          {/* Details */}
          <Card>
            <CardHeader>
              <CardTitle>{t('sections.details')}</CardTitle>
            </CardHeader>
            <CardContent>
              <form
                className="grid gap-4 sm:grid-cols-2"
                onSubmit={(e) => {
                  e.preventDefault()
                  save(details, t('toast.saved'))
                }}
              >
                {DETAIL_FIELDS.map((field) => (
                  <div key={field} className={field === 'service_requested' ? 'grid gap-2 sm:col-span-2' : 'grid gap-2'}>
                    <Label htmlFor={field}>{t(`fields.${field === 'service_requested' ? 'service' : field}`)}</Label>
                    <Input
                      id={field}
                      value={details[field]}
                      dir={field === 'phone' ? 'ltr' : undefined}
                      inputMode={field === 'phone' ? 'tel' : undefined}
                      placeholder={field === 'phone' ? '01XXXXXXXXX' : undefined}
                      onChange={(e) => setDetails((prev) => ({ ...prev, [field]: e.target.value }))}
                    />
                  </div>
                ))}
                <div className="sm:col-span-2 flex justify-end">
                  <Button type="submit" disabled={!detailsDirty || isPending}>
                    {tCommon('save')}
                  </Button>
                </div>
              </form>
            </CardContent>
          </Card>

          {/* Notes */}
          <Card>
            <CardHeader>
              <CardTitle>{t('sections.notes')}</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3">
              <Textarea
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder={t('notesPlaceholder')}
                rows={5}
                maxLength={5000}
                aria-label={t('sections.notes')}
              />
              <div className="flex justify-end">
                <Button onClick={() => save({ notes }, t('toast.notesSaved'))} disabled={!notesDirty || isPending}>
                  {t('saveNotes')}
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <div className="grid gap-6">
          {ai && (
            <Card size="sm">
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Bot className="size-4" />
                  {t('sections.ai')}
                </CardTitle>
                <CardDescription>{t('aiDescription')}</CardDescription>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-3 text-sm">
                  {lead.confidence_score !== null && (
                    <div className="grid gap-0.5">
                      <dt className="text-xs text-muted-foreground">{t('fields.confidence')}</dt>
                      <dd>
                        <Badge variant="secondary">
                          {format.number(lead.confidence_score, { style: 'percent' })}
                        </Badge>
                      </dd>
                    </div>
                  )}
                  {ai.summary && <AiField label={t('ai.summary')}>{ai.summary}</AiField>}
                  {ai.preferred_time && <AiField label={t('ai.preferredTime')}>{ai.preferred_time}</AiField>}
                  {ai.service_requested && <AiField label={t('fields.service')}>{ai.service_requested}</AiField>}
                  {'phone_raw' in ai && typeof ai.phone_raw === 'string' && ai.phone_raw !== lead.phone && (
                    <AiField label={t('ai.phoneRaw')}>
                      <span dir="ltr">{ai.phone_raw}</span>
                    </AiField>
                  )}
                </dl>
              </CardContent>
            </Card>
          )}

          <Card size="sm">
            <CardHeader>
              <CardTitle>{t('sections.timeline')}</CardTitle>
            </CardHeader>
            <CardContent>
              {events.length === 0 ? (
                <p className="text-sm text-muted-foreground">{t('timeline.empty')}</p>
              ) : (
                <ol className="relative grid gap-4 border-s ps-4">
                  {events.map((event) => (
                    <li key={event.id} className="relative text-sm">
                      <span className="absolute -start-[21px] top-1.5 size-2 rounded-full bg-primary" />
                      <p>
                        <span className="font-medium">{actorName(event.actor_id)}</span>{' '}
                        <TimelineText event={event} />
                      </p>
                      <RelativeTime date={event.created_at} className="text-xs text-muted-foreground" />
                    </li>
                  ))}
                </ol>
              )}
            </CardContent>
          </Card>
        </div>
      </div>
    </div>
  )
}

function AiField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd>{children}</dd>
    </div>
  )
}

function TimelineText({ event }: { event: LeadEvent }) {
  const t = useTranslations('leads')
  const format = useFormatter()
  const status = (value: string | null) => (value ? t(`status.${value as LeadStatus}`) : '—')
  const when = (value: string | null) =>
    value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : ''

  switch (event.event_type) {
    case 'created':
      return <>{t('timeline.created')}</>
    case 'status_changed':
      return <>{t('timeline.statusChanged', { from: status(event.from_value), to: status(event.to_value) })}</>
    case 'follow_up_set':
      return event.to_value ? (
        <>{t('timeline.followUpSet', { date: when(event.to_value) })}</>
      ) : (
        <>{t('timeline.followUpCleared')}</>
      )
    case 'contacted':
      return <>{t('timeline.contacted')}</>
    case 'notes_updated':
      return <>{t('timeline.notesUpdated')}</>
    case 'details_updated': {
      const fields = (event.to_value ?? '')
        .split(',')
        .filter(Boolean)
        .map((field) => t(`fields.${field === 'service_requested' ? 'service' : field}`))
      return <>{t('timeline.detailsUpdated', { fields: format.list(fields, { type: 'conjunction' }) })}</>
    }
  }
}
