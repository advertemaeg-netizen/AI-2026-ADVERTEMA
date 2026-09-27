'use client'

import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { CalendarClock, Tag } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card'
import { SubscriptionStatusBadge } from './status-badges'
import { useMoney } from './use-money'
import type { SubscriptionDetails } from '@/lib/types/subscription'

/** Plan, effective price (original struck through under a custom price), renewal. */
export function CurrentPlanCard({ details, title }: { details: SubscriptionDetails; title?: string }) {
  const t = useTranslations('subscription.current')
  const tCard = useTranslations('subscription.card')
  const tTypes = useTranslations('plans.types')
  const locale = useLocale()
  const format = useFormatter()
  const money = useMoney()
  const { subscription, plan, price, custom_pricing: custom } = details
  const discounted = price.current < price.base_current
  const date = (value: string) => format.dateTime(new Date(value), { dateStyle: 'long' })
  const trialing = subscription.status === 'trialing'
  // The monthly message allowance starts over a month after the window began
  const nextReset = new Date(subscription.messages_period_start)
  nextReset.setMonth(nextReset.getMonth() + 1)
  const nextMessagesReset = nextReset.toISOString()

  return (
    <Card>
      <CardHeader>
        <CardDescription>{title ?? t('title')}</CardDescription>
        <CardTitle className="flex flex-wrap items-center gap-2 text-2xl">
          {locale === 'ar' ? plan.name_ar : plan.name}
          <SubscriptionStatusBadge status={subscription.status} usable={subscription.usable} />
          <Badge variant="outline">{tTypes(plan.plan_type)}</Badge>
          {custom?.applies && (
            <Badge className="gap-1 bg-emerald-600 text-white hover:bg-emerald-600">
              <Tag className="size-3" />
              {tCard('specialPrice')}
            </Badge>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-2">
        <div>
          <div className="text-sm text-muted-foreground">{t(`price.${subscription.billing_cycle}`)}</div>
          {discounted && (
            <div className="text-sm text-muted-foreground line-through">{money.withCurrency(price.base_current)}</div>
          )}
          <div className="flex items-baseline gap-1.5">
            <span className="text-3xl font-bold tabular-nums">{money.amount(price.current)}</span>
            <span className="text-sm text-muted-foreground">
              {tCard(subscription.billing_cycle === 'yearly' ? 'perYear' : 'perMonth')}
            </span>
          </div>
          {custom?.applies && (
            <p className="mt-2 text-sm text-muted-foreground">
              {custom.reason && <span className="block">{t('customReason', { reason: custom.reason })}</span>}
              {custom.valid_until && <span className="block">{t('customUntil', { date: date(custom.valid_until) })}</span>}
            </p>
          )}
        </div>
        <div className="grid content-start gap-2 text-sm">
          <div className="flex items-center gap-2">
            <CalendarClock className="size-4 text-muted-foreground" />
            {trialing && subscription.trial_ends_at
              ? t(subscription.usable ? 'trialEnds' : 'trialEnded', { date: date(subscription.trial_ends_at) })
              : t(subscription.status === 'cancelled' ? 'endsOn' : 'renewsOn', {
                  date: date(subscription.current_period_end),
                })}
          </div>
          <div className="text-muted-foreground">{t('messagesReset', { date: date(nextMessagesReset) })}</div>
          {!subscription.usable && <p className="text-destructive">{t('inactiveNotice')}</p>}
        </div>
      </CardContent>
    </Card>
  )
}
