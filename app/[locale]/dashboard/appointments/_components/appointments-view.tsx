'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useNow, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CalendarX2, CheckCircle2, MessageCircle, Phone, UserCheck, UserX } from 'lucide-react'
import { Link, usePathname, useRouter } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Card, CardContent } from '@/components/ui/card'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AppointmentStateBadge } from '@/components/appointments/appointment-state-badge'
import { NoShowDialog } from '@/components/appointments/no-show-dialog'
import { confirmArrival, markNoShow } from '@/lib/actions/appointments'
import { cairoParts } from '@/lib/cairo-time'
import { telHref, whatsappHref } from '@/lib/phone'
import {
  APPOINTMENT_RANGES,
  appointmentState,
  type Appointment,
  type AppointmentRange,
} from '@/lib/types/appointments'

export function AppointmentsView({
  range,
  appointments,
  showClient,
}: {
  range: AppointmentRange
  appointments: Appointment[]
  showClient: boolean
}) {
  const t = useTranslations('appointments')
  const format = useFormatter()
  const router = useRouter()
  const pathname = usePathname()
  const now = useNow({ updateInterval: 60_000 })
  const [isPending, startTransition] = useTransition()
  const [noShowFor, setNoShowFor] = useState<Appointment | null>(null)

  // One timeline section per Cairo calendar day
  const days = new Map<string, Appointment[]>()
  for (const appointment of appointments) {
    const key = cairoParts(appointment.appointment_at).dateKey
    days.set(key, [...(days.get(key) ?? []), appointment])
  }

  function changeRange(value: string) {
    startTransition(() => router.replace(value === 'today' ? pathname : `${pathname}?range=${value}`))
  }

  function arrive(appointment: Appointment) {
    startTransition(async () => {
      const result = await confirmArrival(appointment.id)
      if (result.ok) toast.success(t('toast.arrived'))
      else toast.error(t(`errors.${result.error}`))
    })
  }

  function noShow(reason: string) {
    if (!noShowFor) return
    const id = noShowFor.id
    startTransition(async () => {
      const result = await markNoShow(id, reason)
      if (result.ok) {
        toast.success(t('toast.noShow'))
        setNoShowFor(null)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <div className="grid gap-4">
      <Tabs value={range} onValueChange={changeRange}>
        <TabsList>
          {APPOINTMENT_RANGES.map((value) => (
            <TabsTrigger key={value} value={value}>
              {t(`ranges.${value}`)}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>

      {appointments.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center gap-2 py-16 text-center text-sm text-muted-foreground">
            <CalendarX2 className="size-8" />
            {t(`empty.${range}`)}
          </CardContent>
        </Card>
      ) : (
        [...days.entries()].map(([dateKey, items]) => (
          <section key={dateKey} className="grid gap-2">
            <h2 className="text-sm font-medium text-muted-foreground">
              {format.dateTime(new Date(items[0].appointment_at), { weekday: 'long', day: 'numeric', month: 'long' })}
              <span className="ms-2 text-xs">({t('count', { count: items.length })})</span>
            </h2>
            <Card className="py-0">
              <CardContent className="px-0">
                <ol className="divide-y">
                  {items.map((appointment) => {
                    const state = appointmentState(appointment, now)
                    const resolved = state === 'attended' || state === 'noShow'
                    return (
                      <li key={appointment.id} className="flex flex-wrap items-center gap-4 px-4 py-3">
                        <time
                          dateTime={appointment.appointment_at}
                          className="w-16 shrink-0 text-lg font-semibold tabular-nums"
                        >
                          {format.dateTime(new Date(appointment.appointment_at), { timeStyle: 'short' })}
                        </time>

                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <Link href={`/dashboard/leads/${appointment.id}`} className="font-medium hover:underline">
                              {appointment.name || t('unnamed')}
                            </Link>
                            <AppointmentStateBadge state={state} />
                            {appointment.appointment_confirmed && !resolved && (
                              <Badge variant="outline" className="gap-1">
                                <CheckCircle2 className="size-3" />
                                {t('confirmedBadge')}
                              </Badge>
                            )}
                          </div>
                          <p className="truncate text-sm text-muted-foreground">
                            {appointment.phone && <span dir="ltr">{appointment.phone}</span>}
                            {appointment.phone && appointment.service_requested && ' · '}
                            {appointment.service_requested}
                            {showClient && ` · ${appointment.client.name}`}
                          </p>
                        </div>

                        <div className="flex flex-wrap items-center gap-1.5">
                          {!resolved && (
                            <>
                              <Button size="sm" onClick={() => arrive(appointment)} disabled={isPending}>
                                <UserCheck data-icon="inline-start" />
                                {t('actions.confirmArrival')}
                              </Button>
                              <Button
                                size="sm"
                                variant="outline"
                                onClick={() => setNoShowFor(appointment)}
                                disabled={isPending}
                              >
                                <UserX data-icon="inline-start" />
                                {t('actions.noShow')}
                              </Button>
                            </>
                          )}
                          {appointment.phone && (
                            <>
                              <Button size="icon-sm" variant="ghost" asChild>
                                <a href={telHref(appointment.phone)} aria-label={t('actions.call')}>
                                  <Phone />
                                </a>
                              </Button>
                              <Button size="icon-sm" variant="ghost" asChild className="text-emerald-600">
                                <a
                                  href={whatsappHref(appointment.phone)}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  aria-label={t('actions.whatsapp')}
                                >
                                  <MessageCircle />
                                </a>
                              </Button>
                            </>
                          )}
                        </div>
                      </li>
                    )
                  })}
                </ol>
              </CardContent>
            </Card>
          </section>
        ))
      )}

      <NoShowDialog
        open={!!noShowFor}
        onOpenChange={(open) => !open && setNoShowFor(null)}
        pending={isPending}
        name={noShowFor?.name || t('unnamed')}
        onConfirm={noShow}
      />
    </div>
  )
}
