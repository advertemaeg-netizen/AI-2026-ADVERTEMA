import { useTranslations } from 'next-intl'
import { StateBadge, type BadgeVariant } from '@/components/ui/badge'
import type { LeadStatus } from '@/lib/types/leads'

export const LEAD_STATUS_VARIANT: Record<LeadStatus, BadgeVariant> = {
  new: 'info',
  contacted: 'progress',
  appointment_booked: 'scheduled',
  showed_up: 'positive',
  no_show: 'critical',
  lost: 'quiet',
}

export function LeadStatusBadge({ status }: { status: LeadStatus }) {
  const t = useTranslations('leads')
  return (
    <StateBadge state={status} variant={LEAD_STATUS_VARIANT[status]}>
      {t(`status.${status}`)}
    </StateBadge>
  )
}
