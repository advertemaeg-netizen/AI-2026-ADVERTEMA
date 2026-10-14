'use client'

import { useTranslations } from 'next-intl'
import { Check } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { cn } from '@/lib/utils'
import { useMoney } from './use-money'

/**
 * A plan as customers see it: name, big price (the original struck through
 * when a custom price applies), green-checked features and an action.
 * Shared by the subscription page and the admin plan editor's preview.
 */
export function PlanCard({
  name,
  features,
  price,
  originalPrice,
  current = false,
  popular = false,
  inactive = false,
  action,
}: {
  name: string
  features: string[]
  price: number
  /** Shown struck through when higher than price */
  originalPrice?: number
  current?: boolean
  popular?: boolean
  inactive?: boolean
  action?: React.ReactNode
}) {
  const t = useTranslations('subscription.card')
  const money = useMoney()
  const discounted = originalPrice !== undefined && originalPrice > price

  return (
    <div
      className={cn(
        'relative flex h-full flex-col rounded-xl border bg-card p-6 text-card-foreground shadow-sm',
        current && 'border-2 border-positive-solid shadow-raised',
        popular && !current && 'border-2 border-primary shadow-md',
        inactive && 'opacity-60'
      )}
    >
      {(current || popular) && (
        <Badge
          className={cn(
            'absolute inset-x-0 -top-3 mx-auto w-fit px-3',
            current && 'bg-positive-fill text-positive-fill-foreground hover:bg-positive-fill'
          )}
        >
          {current ? t('current') : t('popular')}
        </Badge>
      )}

      <h3 className="text-lg font-semibold">{name}</h3>

      <div className="mt-4 min-h-16">
        {discounted && (
          <div className="text-sm text-muted-foreground line-through decoration-destructive/70">
            {money.withCurrency(originalPrice)}
          </div>
        )}
        <div className="flex flex-wrap items-baseline gap-x-1.5">
          <span className="text-4xl font-bold tracking-tight tabular-nums">{money.amount(price)}</span>
          <span className="text-sm text-muted-foreground">{t('perMonth')}</span>
        </div>
        {discounted && (
          <Badge variant="positive" className="mt-2">
            {t('specialPrice')}
          </Badge>
        )}
      </div>

      <ul className="mt-6 grid gap-3 text-sm">
        {features.map((feature, index) => (
          <li key={index} className="flex items-start gap-2.5">
            <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full bg-positive-fill/40 text-positive">
              <Check className="size-3.5" strokeWidth={3} aria-hidden />
            </span>
            <span>{feature}</span>
          </li>
        ))}
      </ul>

      {action && <div className="mt-auto pt-6">{action}</div>}
    </div>
  )
}
