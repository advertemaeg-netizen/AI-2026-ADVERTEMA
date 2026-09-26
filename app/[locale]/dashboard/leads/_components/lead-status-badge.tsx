import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import type { LeadStatus } from '@/lib/types/leads'

export const LEAD_STATUS_STYLES: Record<LeadStatus, string> = {
  new: 'bg-blue-500/15 text-blue-700 dark:text-blue-300',
  contacted: 'bg-amber-500/15 text-amber-700 dark:text-amber-300',
  appointment_booked: 'bg-violet-500/15 text-violet-700 dark:text-violet-300',
  showed_up: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-300',
  no_show: 'bg-orange-500/15 text-orange-700 dark:text-orange-300',
  lost: 'bg-muted text-muted-foreground',
}

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const t = useTranslations('leads')
  return (
    <Badge variant="secondary" className={LEAD_STATUS_STYLES[status]}>
      {t(`status.${status}`)}
    </Badge>
  )
}
