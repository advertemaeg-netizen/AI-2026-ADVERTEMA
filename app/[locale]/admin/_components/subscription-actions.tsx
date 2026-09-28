'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CalendarPlus, MoreHorizontal, Package, RotateCcw, Tag, TagsIcon } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { CustomPricingDialog } from '@/components/billing/custom-pricing-dialog'
import { useMoney } from '@/components/billing/use-money'
import {
  changePlan,
  extendPeriod,
  removeCustomPricing,
  resetUsage,
  setCustomPricing,
  type BillingActionResult,
} from '@/lib/actions/admin-subscriptions'
import { SUBSCRIPTION_STATUSES, type Plan, type SubscriptionStatus } from '@/lib/types/subscription'

/** What the actions need to know about one organization's subscription */
export type SubscriptionTarget = {
  organizationId: string
  organizationName: string
  planId: string
  status: SubscriptionStatus
  notes: string | null
  hasCustomPricing: boolean
  /** The current plan's monthly price, for the custom price preview */
  basePrice: number
}

type Open = 'plan' | 'pricing' | 'extend' | 'reset' | 'removePricing' | null

/** Super admin menu for one subscription (admin subscriptions table, org details). */
export function SubscriptionActions({
  target,
  plans,
  variant = 'menu',
}: {
  target: SubscriptionTarget
  plans: Plan[]
  /** menu: "…" button (tables); buttons: a row of buttons (org details page) */
  variant?: 'menu' | 'buttons'
}) {
  const t = useTranslations('subscription.admin')
  const [open, setOpen] = useState<Open>(null)
  const close = () => setOpen(null)

  const items: { key: Exclude<Open, null>; icon: React.ElementType; show?: boolean; destructive?: boolean }[] = [
    { key: 'plan', icon: Package },
    { key: 'pricing', icon: Tag },
    { key: 'extend', icon: CalendarPlus },
    { key: 'reset', icon: RotateCcw },
    { key: 'removePricing', icon: TagsIcon, show: target.hasCustomPricing, destructive: true },
  ]

  return (
    <>
      {variant === 'menu' ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t('actionsLabel')}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            {items
              .filter((item) => item.show !== false)
              .map((item) => (
                <div key={item.key}>
                  {item.destructive && <DropdownMenuSeparator />}
                  <DropdownMenuItem variant={item.destructive ? 'destructive' : 'default'} onSelect={() => setOpen(item.key)}>
                    <item.icon />
                    {t(`actions.${item.key}`)}
                  </DropdownMenuItem>
                </div>
              ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex flex-wrap gap-2">
          {items
            .filter((item) => item.show !== false)
            .map((item) => (
              <Button
                key={item.key}
                variant={item.destructive ? 'ghost' : 'outline'}
                size="sm"
                className={item.destructive ? 'text-destructive' : undefined}
                onClick={() => setOpen(item.key)}
              >
                <item.icon />
                {t(`actions.${item.key}`)}
              </Button>
            ))}
        </div>
      )}

      {open === 'plan' && <ChangePlanDialog target={target} plans={plans} onClose={close} />}
      {open === 'pricing' && (
        <CustomPricingDialog
          subject="organization"
          name={target.organizationName}
          basePrice={target.basePrice}
          hasCustomPricing={target.hasCustomPricing}
          save={(input) => setCustomPricing(target.organizationId, input)}
          onClose={close}
        />
      )}
      {open === 'extend' && <ExtendDialog target={target} onClose={close} />}
      {open === 'reset' && (
        <ConfirmDialog
          title={t('reset.title', { name: target.organizationName })}
          description={t('reset.description')}
          confirm={t('reset.confirm')}
          run={() => resetUsage(target.organizationId)}
          success={t('toast.reset')}
          onClose={close}
        />
      )}
      {open === 'removePricing' && (
        <ConfirmDialog
          title={t('removePricing.title', { name: target.organizationName })}
          description={t('removePricing.description')}
          confirm={t('removePricing.confirm')}
          destructive
          run={() => removeCustomPricing(target.organizationId)}
          success={t('toast.pricingRemoved')}
          onClose={close}
        />
      )}
    </>
  )
}

function useSubmit(onClose: () => void) {
  const t = useTranslations('subscription.admin')
  const [isPending, startTransition] = useTransition()
  function submit(run: () => Promise<BillingActionResult>, success: string) {
    startTransition(async () => {
      const result = await run()
      if (result.ok) {
        toast.success(success)
        onClose()
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }
  return { isPending, submit }
}

function DialogShell({
  title,
  description,
  isPending,
  onClose,
  onSubmit,
  submitLabel,
  children,
}: {
  title: string
  description?: string
  isPending: boolean
  onClose: () => void
  onSubmit: () => void
  submitLabel: string
  children: React.ReactNode
}) {
  const tCommon = useTranslations('common')
  return (
    <Dialog open onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            onSubmit()
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description && <DialogDescription>{description}</DialogDescription>}
          </DialogHeader>
          {children}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? tCommon('loading') : submitLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function ChangePlanDialog({ target, plans, onClose }: { target: SubscriptionTarget; plans: Plan[]; onClose: () => void }) {
  const t = useTranslations('subscription.admin')
  const tStatus = useTranslations('subscription.status')
  const locale = useLocale()
  const money = useMoney()
  const [planId, setPlanId] = useState(target.planId)
  const [status, setStatus] = useState<SubscriptionStatus>(target.status)
  const [notes, setNotes] = useState(target.notes ?? '')
  const { isPending, submit } = useSubmit(onClose)
  // Organizations are on agency plans; inactive ones stay selectable only if the org is already on one
  const options = plans.filter((p) => p.plan_type === 'agency' && (p.is_active || p.id === target.planId))

  return (
    <DialogShell
      title={t('changePlan.title', { name: target.organizationName })}
      description={t('changePlan.description')}
      isPending={isPending}
      onClose={onClose}
      submitLabel={t('changePlan.submit')}
      onSubmit={() =>
        submit(
          () => changePlan(target.organizationId, { plan_id: planId, status, notes: notes.trim() || null }),
          t('toast.planChanged')
        )
      }
    >
      <div className="grid gap-2">
        <Label htmlFor="change-plan">{t('changePlan.plan')}</Label>
        <Select value={planId} onValueChange={setPlanId}>
          <SelectTrigger id="change-plan" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {options.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                {locale === 'ar' ? plan.name_ar : plan.name} · {money.withCurrency(plan.price_monthly)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="change-status">{t('changePlan.status')}</Label>
        <Select value={status} onValueChange={(v) => setStatus(v as SubscriptionStatus)}>
          <SelectTrigger id="change-status" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            {SUBSCRIPTION_STATUSES.map((s) => (
              <SelectItem key={s} value={s}>
                {tStatus(s)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="grid gap-2">
        <Label htmlFor="change-notes">{t('changePlan.notes')}</Label>
        <Textarea id="change-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} />
      </div>
    </DialogShell>
  )
}

const EXTEND_PRESETS = [7, 14, 30]

function ExtendDialog({ target, onClose }: { target: SubscriptionTarget; onClose: () => void }) {
  const t = useTranslations('subscription.admin.extend')
  const tAdmin = useTranslations('subscription.admin')
  const [days, setDays] = useState('14')
  const { isPending, submit } = useSubmit(onClose)

  return (
    <DialogShell
      title={t('title', { name: target.organizationName })}
      description={t(target.status === 'trialing' ? 'descriptionTrial' : 'description')}
      isPending={isPending}
      onClose={onClose}
      submitLabel={t('submit')}
      onSubmit={() => submit(() => extendPeriod(target.organizationId, Number(days)), tAdmin('toast.extended'))}
    >
      <div className="flex flex-wrap gap-2">
        {EXTEND_PRESETS.map((preset) => (
          <Button
            key={preset}
            type="button"
            size="sm"
            variant={Number(days) === preset ? 'default' : 'outline'}
            onClick={() => setDays(String(preset))}
          >
            {t('days', { count: preset })}
          </Button>
        ))}
      </div>
      <div className="grid gap-2">
        <Label htmlFor="extend-days">{t('customDays')}</Label>
        <Input id="extend-days" type="number" min={1} max={366} step={1} dir="ltr" value={days} onChange={(e) => setDays(e.target.value)} required />
      </div>
    </DialogShell>
  )
}

function ConfirmDialog({
  title,
  description,
  confirm,
  destructive = false,
  run,
  success,
  onClose,
}: {
  title: string
  description: string
  confirm: string
  destructive?: boolean
  run: () => Promise<BillingActionResult>
  success: string
  onClose: () => void
}) {
  const tCommon = useTranslations('common')
  const { isPending, submit } = useSubmit(onClose)
  return (
    <AlertDialog open onOpenChange={(open) => !open && !isPending && onClose()}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>{tCommon('cancel')}</AlertDialogCancel>
          <AlertDialogAction
            variant={destructive ? 'destructive' : 'default'}
            disabled={isPending}
            onClick={(e) => {
              e.preventDefault()
              submit(run, success)
            }}
          >
            {isPending ? tCommon('loading') : confirm}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
