import { useTranslations } from 'next-intl'
import { StateBadge, type BadgeVariant } from '@/components/ui/badge'
import { isUncheckedDayRequest } from '@/lib/types/appointments'
import type { LeadStatus, LeadStatusVisit } from '@/lib/types/leads'

export const LEAD_STATUS_VARIANT: Record<LeadStatus, BadgeVariant> = {
  new: 'info',
  contacted: 'progress',
  appointment_booked: 'scheduled',
  showed_up: 'positive',
  no_show: 'critical',
  lost: 'quiet',
}

/**
 * A lead's status. A booked day-only visit nobody has checked is shown as the
 * appointments list shows it, a request (the same words and tone), never as
 * «تم حجز موعد»: one screen, one story. The visit is required so no list can
 * leave it out.
 */
export function LeadStatusBadge({ status, visit }: { status: LeadStatus; visit: LeadStatusVisit }) {
  const t = useTranslations('leads')
  const tStates = useTranslations('appointments.states')
  if (status === 'appointment_booked' && visit.appointment_at && isUncheckedDayRequest({ ...visit, appointment_at: visit.appointment_at })) {
    return (
      <StateBadge state="request" variant="warning">
        {tStates('request')}
      </StateBadge>
    )
  }
  return (
    <StateBadge state={status} variant={LEAD_STATUS_VARIANT[status]}>
      {t(`status.${status}`)}
    </StateBadge>
  )
}
