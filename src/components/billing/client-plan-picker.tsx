'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog'
import { PlanCard } from '@/components/billing/plan-card'
import { useMoney } from '@/components/billing/use-money'
import { changeClientPlan } from '@/lib/actions/client-subscription'
import type { AvailablePlan } from '@/lib/types/subscription'

/**
 * Business plans for one client, priced for it (its custom price applied).
 * The agency switches the client's plan right here; the client's
 * own admins see the plans and ask their agency.
 */
export function ClientPlanPicker({
  clientId,
  clientName,
  plans,
  currentPlanId,
  canChange,
}: {
  clientId: string
  clientName: string
  plans: AvailablePlan[]
  currentPlanId: string
  canChange: boolean
}) {
  const t = useTranslations('clientSubscription.plans')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const money = useMoney()
  const [chosen, setChosen] = useState<AvailablePlan | null>(null)
  const [isPending, startTransition] = useTransition()

  const currentIndex = plans.findIndex((p) => p.id === currentPlanId)
  const popularId = plans[currentIndex + 1]?.id
  const name = (plan: AvailablePlan) => (locale === 'ar' ? plan.name_ar : plan.name)

  function confirm() {
    if (!chosen) return
    startTransition(async () => {
      const result = await changeClientPlan(clientId, { plan_id: chosen.id })
      if (result.ok) {
        toast.success(t('changed', { plan: name(chosen) }))
        setChosen(null)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <div className="grid gap-6">
      <div className="grid gap-6 pt-3 md:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan, index) => {
          const current = plan.id === currentPlanId
          return (
            <PlanCard
              key={plan.id}
              name={name(plan)}
              features={plan.features.map((f) => (locale === 'ar' ? f.ar : f.en))}
              price={plan.effective_monthly}
              originalPrice={plan.price_monthly}
              current={current}
              popular={plan.id === popularId}
              action={
                current ? (
                  <Button className="w-full" variant="outline" disabled>
                    {t('currentPlan')}
                  </Button>
                ) : canChange ? (
                  <Button
                    className="w-full"
                    variant={plan.id === popularId ? 'default' : 'outline'}
                    onClick={() => setChosen(plan)}
                  >
                    {currentIndex === -1 || index > currentIndex ? t('upgrade') : t('switch')}
                  </Button>
                ) : (
                  <p className="text-center text-xs text-muted-foreground">{t('askAgency')}</p>
                )
              }
            />
          )
        })}
      </div>

      <AlertDialog open={!!chosen} onOpenChange={(open) => !open && !isPending && setChosen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('confirmTitle', { plan: chosen ? name(chosen) : '', client: clientName })}</AlertDialogTitle>
            <AlertDialogDescription>
              {chosen &&
                t('confirmDescription', { price: money.withCurrency(chosen.effective_monthly) })}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault()
                confirm()
              }}
            >
              {isPending ? tCommon('loading') : t('confirm')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
