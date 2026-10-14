'use client'

import { useTranslations } from 'next-intl'
import { StateBadge, type BadgeVariant } from '@/components/ui/badge'
import type { InvoiceStatus, SubscriptionStatus } from '@/lib/types/subscription'

const SUBSCRIPTION_VARIANT: Record<SubscriptionStatus, BadgeVariant> = {
  trialing: 'info',
  active: 'positive',
  past_due: 'warning',
  cancelled: 'destructive',
}

/** `usable` false on a trialing subscription = the trial is over */
export function SubscriptionStatusBadge({ status, usable = true }: { status: SubscriptionStatus; usable?: boolean }) {
  const t = useTranslations('subscription.status')
  const expired = status === 'trialing' && !usable
  return (
    <StateBadge
      state={expired ? 'trialEnded' : status}
      variant={expired ? SUBSCRIPTION_VARIANT.cancelled : SUBSCRIPTION_VARIANT[status]}
    >
      {expired ? t('trialEnded') : t(status)}
    </StateBadge>
  )
}

const INVOICE_VARIANT: Record<InvoiceStatus, BadgeVariant> = {
  draft: 'quiet',
  sent: 'info',
  paid: 'positive',
  overdue: 'destructive',
  cancelled: 'quiet',
}

export function InvoiceStatusBadge({ status }: { status: InvoiceStatus }) {
  const t = useTranslations('invoices.status')
  return (
    <StateBadge state={status} variant={INVOICE_VARIANT[status]} className={status === 'cancelled' ? 'line-through' : undefined}>
      {t(status)}
    </StateBadge>
  )
}
