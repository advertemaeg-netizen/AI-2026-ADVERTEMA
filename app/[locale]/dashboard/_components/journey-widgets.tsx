import { useFormatter, useTranslations } from 'next-intl'
import { ArrowDown, CalendarDays, UserCheck } from 'lucide-react'
import { Link } from '@/i18n/navigation'
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { AppointmentStateBadge } from '@/components/appointments/appointment-state-badge'
import { appointmentState, type Appointment, type JourneyStats } from '@/lib/types/appointments'

export function TodayAppointmentsCard({ appointments }: { appointments: Appointment[] }) {
  const t = useTranslations('journey')
  const format = useFormatter()
  const shown = appointments.slice(0, 5)

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <CalendarDays className="size-4" />
          {t('today.title')}
        </CardTitle>
        <CardAction>
          <Link href="/dashboard/appointments" className="text-xs text-muted-foreground hover:underline">
            {t('today.viewAll')}
          </Link>
        </CardAction>
      </CardHeader>
      <CardContent className="grid gap-3">
        <div className="text-2xl font-bold">{format.number(appointments.length)}</div>
        {shown.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('today.empty')}</p>
        ) : (
          <ul className="grid gap-2">
            {shown.map((appointment) => (
              <li key={appointment.id}>
                <Link
                  href={`/dashboard/leads/${appointment.id}`}
                  className="flex items-center gap-2 rounded-md text-sm hover:bg-muted/50"
                >
                  <span className="w-14 shrink-0 font-medium tabular-nums">
                    {format.dateTime(new Date(appointment.appointment_at), { timeStyle: 'short' })}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{appointment.name || t('unnamed')}</span>
                  <AppointmentStateBadge state={appointmentState(appointment)} />
                </Link>
              </li>
            ))}
          </ul>
        )}
        {appointments.length > shown.length && (
          <p className="text-xs text-muted-foreground">
            {t('today.more', { count: appointments.length - shown.length })}
          </p>
        )}
      </CardContent>
    </Card>
  )
}

export function AttendanceCard({ current, previous }: { current: JourneyStats; previous: JourneyStats }) {
  const t = useTranslations('journey')
  const format = useFormatter()
  const rate = current.attendanceRate

  let comparison = t('attendance.noComparison')
  if (rate !== null && previous.attendanceRate !== null) {
    const points = (rate - previous.attendanceRate) * 100
    comparison = t('attendance.change', {
      change: `${points >= 0 ? '+' : ''}${format.number(points, { maximumFractionDigits: 1 })}`,
    })
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
          <UserCheck className="size-4" />
          {t('attendance.title')}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1">
        <div className="text-2xl font-bold">
          {rate === null ? '—' : format.number(rate, { style: 'percent', maximumFractionDigits: 1 })}
        </div>
        <p className="text-xs text-muted-foreground">
          {t('attendance.detail', { showed: current.showedUp, noShow: current.noShow })}
        </p>
        <p className="text-xs text-muted-foreground">{comparison}</p>
      </CardContent>
    </Card>
  )
}

/** conversations → leads → appointments → attended, with step-to-step rates */
export function JourneyFunnel({ conversations, stats }: { conversations: number; stats: JourneyStats }) {
  const t = useTranslations('journey')
  const format = useFormatter()

  const steps = [
    { key: 'conversations', value: conversations },
    { key: 'leads', value: stats.leads },
    { key: 'appointments', value: stats.booked },
    { key: 'attended', value: stats.showedUp },
  ] as const
  const top = Math.max(conversations, 1)

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t('funnel.title')}</CardTitle>
        <CardDescription>{t('funnel.description')}</CardDescription>
      </CardHeader>
      <CardContent>
        <ol className="grid gap-1">
          {steps.map((step, i) => {
            const previous = i > 0 ? steps[i - 1].value : null
            return (
              <li key={step.key} className="grid gap-1">
                {previous !== null && (
                  <p className="flex items-center gap-1 ps-1 text-xs text-muted-foreground">
                    <ArrowDown className="size-3" />
                    {previous > 0
                      ? t('funnel.rate', {
                          rate: format.number(step.value / previous, { style: 'percent', maximumFractionDigits: 1 }),
                        })
                      : '—'}
                  </p>
                )}
                <div className="flex items-center gap-3">
                  <span className="w-24 shrink-0 text-sm">{t(`funnel.steps.${step.key}`)}</span>
                  <div className="h-6 flex-1 overflow-hidden rounded-md bg-muted">
                    <div
                      className="h-full rounded-md bg-gradient-to-r from-purple-500 to-orange-500 rtl:bg-gradient-to-l"
                      style={{ width: `${Math.max((step.value / top) * 100, step.value > 0 ? 2 : 0)}%` }}
                    />
                  </div>
                  <span className="w-12 shrink-0 text-end text-sm font-medium tabular-nums">
                    {format.number(step.value)}
                  </span>
                </div>
              </li>
            )
          })}
        </ol>
      </CardContent>
    </Card>
  )
}
