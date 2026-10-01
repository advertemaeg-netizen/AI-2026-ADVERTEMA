'use client'

import { useFormatter, useTranslations } from 'next-intl'
import { Link } from '@/i18n/navigation'
import type { LeadVisit } from '@/lib/types/leads'
import { LeadStatusBadge } from './lead-status-badge'

/**
 * A conversation's leads, one per visit. `numbered` pairs each lead with its
 * position among all of the conversation's leads.
 */
export function LeadVisitsList({ visits }: { visits: { visit: LeadVisit; number: number }[] }) {
  const t = useTranslations('leads.visits')
  const format = useFormatter()
  const date = (value: string, withTime: boolean) =>
    format.dateTime(new Date(value), withTime ? { dateStyle: 'medium', timeStyle: 'short' } : { dateStyle: 'medium' })

  return (
    <ol className="grid gap-2">
      {visits.map(({ visit, number }) => (
        <li key={visit.id}>
          <Link
            href={`/dashboard/leads/${visit.id}`}
            className="grid gap-1 rounded-md border p-3 text-sm transition-colors hover:bg-muted/50 max-md:min-h-11"
          >
            <span className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-medium">{t('visit', { number })}</span>
              <LeadStatusBadge status={visit.status} />
            </span>
            {visit.service_requested && <span className="truncate">{visit.service_requested}</span>}
            <span className="text-xs text-muted-foreground">
              {visit.appointment_at
                ? t('appointment', { date: date(visit.appointment_at, true) })
                : t('noAppointment', { date: date(visit.created_at, false) })}
            </span>
          </Link>
        </li>
      ))}
    </ol>
  )
}
