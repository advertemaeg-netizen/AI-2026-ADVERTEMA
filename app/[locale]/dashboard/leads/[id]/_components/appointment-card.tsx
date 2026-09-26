'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CalendarCheck2, UserCheck, UserX } from 'lucide-react'
import { useRouter } from '@/i18n/navigation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Card, CardAction, CardContent, CardHeader, CardTitle } from '@/components/ui/card'
import { CairoDateTimePicker } from '@/components/cairo-date-time-picker'
import { AppointmentStateBadge } from '@/components/appointments/appointment-state-badge'
import { NoShowDialog } from '@/components/appointments/no-show-dialog'
import {
  confirmArrival,
  markNoShow,
  setAppointment,
  setAppointmentConfirmed,
} from '@/lib/actions/appointments'
import { appointmentState, type AppointmentActionResult } from '@/lib/types/appointments'
import type { LeadDetail } from '@/lib/types/leads'

export function AppointmentCard({ lead }: { lead: LeadDetail }) {
  const t = useTranslations('appointments')
  const format = useFormatter()
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [noShowOpen, setNoShowOpen] = useState(false)

  function run(action: () => Promise<AppointmentActionResult>, success: string, onDone?: () => void) {
    startTransition(async () => {
      const result = await action()
      if (result.ok) {
        toast.success(success)
        onDone?.()
        router.refresh()
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  const state = lead.appointment_at
    ? appointmentState({ appointment_at: lead.appointment_at, showed_up: lead.showed_up })
    : null
  const ai = lead.ai_extracted_data
  // The AI picked the time from a vague phrase ("Thursday morning")
  const approximate =
    !!ai?.appointment_time_approximate && !!ai.appointment_at && ai.appointment_at === lead.appointment_at

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <CalendarCheck2 className="size-4" />
          {t('section.title')}
        </CardTitle>
        {state && (
          <CardAction>
            <AppointmentStateBadge state={state} />
          </CardAction>
        )}
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid gap-2">
          <Label>{t('section.when')}</Label>
          <CairoDateTimePicker
            value={lead.appointment_at}
            placeholder={t('section.pick')}
            disabled={isPending}
            allowPast
            onSave={(iso) => run(() => setAppointment(lead.id, iso), t('toast.appointmentSet'))}
            onClear={() => run(() => setAppointment(lead.id, null), t('toast.appointmentCleared'))}
          />
          {approximate && (
            <p className="text-xs text-amber-700 dark:text-amber-300">{t('section.approximate')}</p>
          )}
          {ai?.preferred_time && !lead.appointment_at && (
            <p className="text-xs text-muted-foreground">{t('section.requested', { time: ai.preferred_time })}</p>
          )}
        </div>

        {lead.appointment_at && (
          <>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>
                {t('section.confirmed')}
                <span className="block text-xs text-muted-foreground">{t('section.confirmedHint')}</span>
              </span>
              <Switch
                checked={lead.appointment_confirmed}
                disabled={isPending}
                onCheckedChange={(checked) =>
                  run(
                    () => setAppointmentConfirmed(lead.id, checked),
                    checked ? t('toast.confirmed') : t('toast.unconfirmed')
                  )
                }
              />
            </label>

            {lead.showed_up === true && lead.arrival_confirmed_at && (
              <Badge variant="secondary" className="w-fit">
                {t('section.arrivedAt', {
                  time: format.dateTime(new Date(lead.arrival_confirmed_at), { dateStyle: 'medium', timeStyle: 'short' }),
                })}
              </Badge>
            )}
            {lead.showed_up === false && (
              <p className="text-sm text-muted-foreground">
                {lead.no_show_reason ? t('section.noShowReason', { reason: lead.no_show_reason }) : t('section.noShowNoReason')}
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant={lead.showed_up === true ? 'secondary' : 'default'}
                disabled={isPending || lead.showed_up === true}
                onClick={() => run(() => confirmArrival(lead.id), t('toast.arrived'))}
              >
                <UserCheck data-icon="inline-start" />
                {t('actions.confirmArrival')}
              </Button>
              <Button
                variant="outline"
                disabled={isPending || lead.showed_up === false}
                onClick={() => setNoShowOpen(true)}
              >
                <UserX data-icon="inline-start" />
                {t('actions.noShow')}
              </Button>
            </div>
          </>
        )}
      </CardContent>

      <NoShowDialog
        open={noShowOpen}
        onOpenChange={setNoShowOpen}
        pending={isPending}
        name={lead.name || t('unnamed')}
        onConfirm={(reason) =>
          run(() => markNoShow(lead.id, reason), t('toast.noShow'), () => setNoShowOpen(false))
        }
      />
    </Card>
  )
}
