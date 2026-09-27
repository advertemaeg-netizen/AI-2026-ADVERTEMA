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
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PlanCard } from '@/components/billing/plan-card'
import { useMoney } from '@/components/billing/use-money'
import { changeClientPlan } from '@/lib/actions/client-subscription'
import type { AvailablePlan, BillingCycle } from '@/lib/types/subscription'

/**
 * Business plans for one client, priced for it (its custom price applied).
 * The agency switches the client's plan (and cycle) right here; the client's
 * own admins see the plans and ask their agency.
 */
export function ClientPlanPicker({
  clientId,
  clientName,
  plans,
  currentPlanId,
  currentCycle,
  canChange,
}: {
  clientId: string
  clientName: string
  plans: AvailablePlan[]
  currentPlanId: string
  currentCycle: BillingCycle
  canChange: boolean
}) {
  const t = useTranslations('clientSubscription.plans')
  const tCycles = useTranslations('subscription.upgrade.cycles')
  const tCommon = useTranslations('common')
  const locale = useLocale()
  const money = useMoney()
  const [cycle, setCycle] = useState<BillingCycle>(currentCycle)
  const [chosen, setChosen] = useState<AvailablePlan | null>(null)
  const [isPending, startTransition] = useTransition()

  const currentIndex = plans.findIndex((p) => p.id === currentPlanId)
  const popularId = plans[currentIndex + 1]?.id
  const name = (plan: AvailablePlan) => (locale === 'ar' ? plan.name_ar : plan.name)
  const priceOf = (plan: AvailablePlan) => (cycle === 'yearly' ? plan.effective_yearly : plan.effective_monthly)

  function confirm() {
    if (!chosen) return
    startTransition(async () => {
      const result = await changeClientPlan(clientId, { plan_id: chosen.id, billing_cycle: cycle })
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
      <Tabs value={cycle} onValueChange={(value) => setCycle(value as BillingCycle)} className="w-fit">
        <TabsList>
          <TabsTrigger value="monthly">{tCycles('monthly')}</TabsTrigger>
          <TabsTrigger value="yearly">{tCycles('yearly')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid gap-6 pt-3 md:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan, index) => {
          // The same plan on the other cycle is still a change
          const current = plan.id === currentPlanId && cycle === currentCycle
          return (
            <PlanCard
              key={plan.id}
              name={name(plan)}
              features={plan.features.map((f) => (locale === 'ar' ? f.ar : f.en))}
              price={priceOf(plan)}
              originalPrice={cycle === 'yearly' ? plan.price_yearly : plan.price_monthly}
              cycle={cycle}
              current={plan.id === currentPlanId}
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
                    {plan.id === currentPlanId
                      ? t('switchCycle')
                      : currentIndex === -1 || index > currentIndex
                        ? t('upgrade')
                        : t('switch')}
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
                t('confirmDescription', {
                  price: money.withCurrency(priceOf(chosen)),
                  cycle: tCycles(cycle),
                })}
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
