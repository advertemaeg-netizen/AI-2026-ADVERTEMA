'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { BillingActionResult, CustomPricingInput } from '@/lib/types/subscription'
import { dateKeyToIso, toDateKey } from './date-key'
import { useMoney } from './use-money'

/**
 * A discount or a fixed price for one customer: an organization (super
 * admins) or one of an agency's clients (the agency). Plan prices themselves
 * are never changed here.
 */
export function CustomPricingDialog({
  subject,
  name,
  basePrice,
  hasCustomPricing,
  save,
  onClose,
}: {
  subject: 'organization' | 'client'
  name: string
  /** Base prices of the current plan, for the preview */
  basePrice: { monthly: number; yearly: number }
  hasCustomPricing: boolean
  save: (input: CustomPricingInput) => Promise<BillingActionResult>
  onClose: () => void
}) {
  const t = useTranslations('subscription.admin.pricing')
  const tAdmin = useTranslations('subscription.admin')
  const tCommon = useTranslations('common')
  const money = useMoney()
  const client = subject === 'client'
  const [type, setType] = useState<'percentage' | 'fixed_price'>('percentage')
  const [percentage, setPercentage] = useState('')
  const [monthly, setMonthly] = useState('')
  const [yearly, setYearly] = useState('')
  const [reason, setReason] = useState('')
  const [until, setUntil] = useState('')
  const [isPending, startTransition] = useTransition()

  const numOrNull = (value: string) => (value.trim() === '' ? null : Number(value))
  const pct = numOrNull(percentage)
  const preview =
    type === 'percentage'
      ? pct !== null && pct > 0 && pct <= 100
        ? {
            monthly: Math.round(basePrice.monthly * (100 - pct)) / 100,
            yearly: Math.round(basePrice.yearly * (100 - pct)) / 100,
          }
        : null
      : { monthly: numOrNull(monthly) ?? basePrice.monthly, yearly: numOrNull(yearly) ?? basePrice.yearly }

  function submit() {
    startTransition(async () => {
      const result = await save({
        discount_type: type,
        discount_percentage: type === 'percentage' ? pct : null,
        fixed_price_monthly: type === 'fixed_price' ? numOrNull(monthly) : null,
        fixed_price_yearly: type === 'fixed_price' ? numOrNull(yearly) : null,
        reason: reason.trim() || null,
        // Valid through the end of that Cairo day
        valid_until: until ? dateKeyToIso(until, '23:59') : null,
      })
      if (result.ok) {
        toast.success(tAdmin('toast.pricingSet'))
        onClose()
      } else {
        toast.error(tAdmin(`errors.${result.error}`))
      }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{t('title', { name })}</DialogTitle>
            <DialogDescription>{t(client ? 'descriptionClient' : 'description')}</DialogDescription>
          </DialogHeader>

          <Tabs value={type} onValueChange={(v) => setType(v as typeof type)}>
            <TabsList className="w-full">
              <TabsTrigger value="percentage" className="flex-1">
                {t('percentage')}
              </TabsTrigger>
              <TabsTrigger value="fixed_price" className="flex-1">
                {t('fixed')}
              </TabsTrigger>
            </TabsList>
          </Tabs>

          {type === 'percentage' ? (
            <div className="grid gap-2">
              <Label htmlFor="pricing-pct">{t('percentageLabel')}</Label>
              <Input id="pricing-pct" type="number" min={1} max={100} step="0.5" dir="ltr" value={percentage} onChange={(e) => setPercentage(e.target.value)} required />
              <p className="text-xs text-muted-foreground">{t(client ? 'percentageHintClient' : 'percentageHint')}</p>
            </div>
          ) : (
            <div className="grid gap-2">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="pricing-monthly">{t('monthly')}</Label>
                  <Input id="pricing-monthly" type="number" min={0} step="0.01" dir="ltr" value={monthly} onChange={(e) => setMonthly(e.target.value)} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="pricing-yearly">{t('yearly')}</Label>
                  <Input id="pricing-yearly" type="number" min={0} step="0.01" dir="ltr" value={yearly} onChange={(e) => setYearly(e.target.value)} />
                </div>
              </div>
              <p className="text-xs text-muted-foreground">{t('fixedHint')}</p>
            </div>
          )}

          {preview && (
            <div className="rounded-md bg-muted p-3 text-sm">
              <div className="text-muted-foreground">{t('preview')}</div>
              <div className="mt-1 grid gap-0.5 tabular-nums">
                <span>
                  <span className="text-muted-foreground line-through">{money.withCurrency(basePrice.monthly)}</span>{' '}
                  → <strong>{money.withCurrency(preview.monthly)}</strong> {t('perMonth')}
                </span>
                <span>
                  <span className="text-muted-foreground line-through">{money.withCurrency(basePrice.yearly)}</span>{' '}
                  → <strong>{money.withCurrency(preview.yearly)}</strong> {t('perYear')}
                </span>
              </div>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="pricing-reason">{t('reason')}</Label>
            <Input id="pricing-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} placeholder={t('reasonPlaceholder')} />
            <p className="text-xs text-muted-foreground">{t(client ? 'reasonHintClient' : 'reasonHint')}</p>
          </div>
          <div className="grid gap-2">
            <Label htmlFor="pricing-until">{t('validUntil')}</Label>
            <Input id="pricing-until" type="date" value={until} min={toDateKey(new Date())} onChange={(e) => setUntil(e.target.value)} />
            <p className="text-xs text-muted-foreground">{t('validUntilHint')}</p>
          </div>
          {hasCustomPricing && (
            <p className="text-xs text-amber-700 dark:text-amber-400">{t(client ? 'replacesClient' : 'replaces')}</p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? tCommon('loading') : t('submit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
