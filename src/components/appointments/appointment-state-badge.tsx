import { useTranslations } from 'next-intl'
import { StateBadge, type BadgeVariant } from '@/components/ui/badge'
import type { AppointmentState } from '@/lib/types/appointments'

const STATE_VARIANT: Record<AppointmentState, BadgeVariant> = {
  upcoming: 'info',
  today: 'scheduled',
  // Needs a call from the team: the guidelines' warning (يحتاج متابعة), never a success
  request: 'warning',
  late: 'warning',
  attended: 'positive',
  noShow: 'destructive',
}

export function AppointmentStateBadge({ state }: { state: AppointmentState }) {
  const t = useTranslations('appointments.states')
  return (
    <StateBadge state={state} variant={STATE_VARIANT[state]}>
      {t(state)}
    </StateBadge>
  )
}
