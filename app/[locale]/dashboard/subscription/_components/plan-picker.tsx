'use client'

import { useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Mail, MessageCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { PlanCard } from '@/components/billing/plan-card'
import type { AvailablePlan, BillingCycle } from '@/lib/types/subscription'

export type SalesContact = { whatsapp: string | null; email: string | null }

/**
 * The plans of the org's type side by side. The current plan is marked; the
 * next one up is "most popular". Upgrading means contacting us (no payment
 * gateway): WhatsApp or email with the plan prefilled.
 */
export function PlanPicker({
  plans,
  currentPlanId,
  currentCycle,
  organizationName,
  contact,
}: {
  plans: AvailablePlan[]
  currentPlanId: string
  currentCycle: BillingCycle
  organizationName: string
  contact: SalesContact
}) {
  const t = useTranslations('subscription.upgrade')
  const locale = useLocale()
  const [cycle, setCycle] = useState<BillingCycle>(currentCycle)
  const [chosen, setChosen] = useState<AvailablePlan | null>(null)

  const currentIndex = plans.findIndex((p) => p.id === currentPlanId)
  const popularId = plans[currentIndex + 1]?.id
  const name = (plan: AvailablePlan) => (locale === 'ar' ? plan.name_ar : plan.name)

  const message = chosen
    ? t('contactMessage', {
        plan: name(chosen),
        cycle: t(`cycles.${cycle}`),
        organization: organizationName,
      })
    : ''

  return (
    <div className="grid gap-6">
      <Tabs value={cycle} onValueChange={(value) => setCycle(value as BillingCycle)} className="w-fit">
        <TabsList>
          <TabsTrigger value="monthly">{t('cycles.monthly')}</TabsTrigger>
          <TabsTrigger value="yearly">{t('cycles.yearly')}</TabsTrigger>
        </TabsList>
      </Tabs>

      <div className="grid gap-6 pt-3 md:grid-cols-2 xl:grid-cols-3">
        {plans.map((plan, index) => {
          const current = plan.id === currentPlanId
          const price = cycle === 'yearly' ? plan.effective_yearly : plan.effective_monthly
          const original = cycle === 'yearly' ? plan.price_yearly : plan.price_monthly
          return (
            <PlanCard
              key={plan.id}
              name={name(plan)}
              features={plan.features.map((f) => (locale === 'ar' ? f.ar : f.en))}
              price={price}
              originalPrice={original}
              cycle={cycle}
              current={current}
              popular={plan.id === popularId}
              action={
                current ? (
                  <Button className="w-full" variant="outline" disabled>
                    {t('currentPlan')}
                  </Button>
                ) : (
                  <Button
                    className="w-full"
                    variant={plan.id === popularId ? 'default' : 'outline'}
                    onClick={() => setChosen(plan)}
                  >
                    {currentIndex === -1 || index > currentIndex ? t('upgrade') : t('switch')}
                  </Button>
                )
              }
            />
          )
        })}
      </div>

      <Dialog open={!!chosen} onOpenChange={(open) => !open && setChosen(null)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t('contactTitle', { plan: chosen ? name(chosen) : '' })}</DialogTitle>
            <DialogDescription>{t('contactDescription')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-3">
            {contact.whatsapp && (
              <Button asChild className="bg-emerald-600 text-white hover:bg-emerald-700">
                <a
                  href={`https://wa.me/${contact.whatsapp}?text=${encodeURIComponent(message)}`}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <MessageCircle />
                  {t('whatsapp')}
                </a>
              </Button>
            )}
            {contact.email && (
              <Button asChild variant="outline">
                <a
                  href={`mailto:${contact.email}?subject=${encodeURIComponent(
                    t('emailSubject', { plan: chosen ? name(chosen) : '' })
                  )}&body=${encodeURIComponent(message)}`}
                >
                  <Mail />
                  {t('email')}
                  <span className="text-xs text-muted-foreground" dir="ltr">
                    {contact.email}
                  </span>
                </a>
              </Button>
            )}
            {!contact.whatsapp && !contact.email && (
              <p className="text-sm text-muted-foreground">{t('noContact')}</p>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
