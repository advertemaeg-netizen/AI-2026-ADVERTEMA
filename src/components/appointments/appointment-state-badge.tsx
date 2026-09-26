import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import type { AppointmentState } from '@/lib/types/appointments'

const STATE_STYLES: Record<AppointmentState, string> = {
  upcoming: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  today: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  late: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  attended: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  noShow: 'bg-destructive/10 text-destructive',
}

export function AppointmentStateBadge({ state }: { state: AppointmentState }) {
  const t = useTranslations('appointments.states')
  return (
    <Badge variant="secondary" className={STATE_STYLES[state]}>
      {t(state)}
    </Badge>
  )
}
