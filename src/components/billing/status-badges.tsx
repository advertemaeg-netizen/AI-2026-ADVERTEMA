'use client'

import { useTranslations } from 'next-intl'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import type { InvoiceStatus, SubscriptionStatus } from '@/lib/types/subscription'

const SUBSCRIPTION_CLASS: Record<SubscriptionStatus, string> = {
  trialing: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  active: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  past_due: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  cancelled: 'bg-destructive/10 text-destructive',
}

/** `usable` false on a trialing subscription = the trial is over */
export function SubscriptionStatusBadge({ status, usable = true }: { status: SubscriptionStatus; usable?: boolean }) {
  const t = useTranslations('subscription.status')
  const expired = status === 'trialing' && !usable
  return (
    <Badge variant="secondary" className={cn(expired ? SUBSCRIPTION_CLASS.cancelled : SUBSCRIPTION_CLASS[status])}>
      {expired ? t('trialEnded') : t(status)}
    </Badge>
  )
}

const INVOICE_CLASS: Record<InvoiceStatus, string> = {
  draft: 'bg-muted text-muted-foreground',
  sent: 'bg-sky-500/15 text-sky-700 dark:text-sky-400',
  paid: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  overdue: 'bg-destructive/10 text-destructive',
  cancelled: 'bg-muted text-muted-foreground line-through',
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const t = useTranslations('invoices.status')
  return (
    <Badge variant="secondary" className={INVOICE_CLASS[status]}>
      {t(status)}
    </Badge>
  )
}
