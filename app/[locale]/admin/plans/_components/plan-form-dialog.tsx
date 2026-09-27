'use client'

import { useState, useTransition } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Switch } from '@/components/ui/switch'
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { PlanCard } from '@/components/billing/plan-card'
import { createPlan, updatePlan } from '@/lib/actions/admin-plans'
import {
  LIMIT_COLUMNS,
  LIMIT_TYPES,
  PLAN_TYPES,
  type BillingCycle,
  type Plan,
  type PlanInput,
  type PlanType,
} from '@/lib/types/subscription'
import { FeaturesEditor } from './features-editor'

type LimitColumn = (typeof LIMIT_COLUMNS)[keyof typeof LIMIT_COLUMNS]
// Form state keeps inputs as text so "" can mean "unlimited"
type FormState = Omit<PlanInput, 'price_monthly' | 'price_yearly' | LimitColumn> & {
  price_monthly: string
  price_yearly: string
} & Record<LimitColumn, string>

function toForm(plan: Plan | null, planType: PlanType): FormState {
  const limits = Object.fromEntries(
    LIMIT_TYPES.map((type) => [LIMIT_COLUMNS[type], plan?.[LIMIT_COLUMNS[type]]?.toString() ?? ''])
  ) as Record<LimitColumn, string>
  return {
    slug: plan?.slug ?? '',
    name: plan?.name ?? '',
    name_ar: plan?.name_ar ?? '',
    plan_type: plan?.plan_type ?? planType,
    price_monthly: plan?.price_monthly.toString() ?? '',
    price_yearly: plan?.price_yearly.toString() ?? '',
    features: plan?.features ?? [],
    is_active: plan?.is_active ?? true,
    ...limits,
  }
}

function toInput(form: FormState): PlanInput {
  const limit = (value: string) => (value.trim() === '' ? null : Number(value))
  return {
    ...form,
    price_monthly: Number(form.price_monthly),
    price_yearly: Number(form.price_yearly),
    messages_limit: limit(form.messages_limit),
    clients_limit: limit(form.clients_limit),
    team_members_limit: limit(form.team_members_limit),
    channels_limit: limit(form.channels_limit),
    knowledge_docs_limit: limit(form.knowledge_docs_limit),
    features: form.features.map((f) => ({ ar: f.ar.trim(), en: f.en.trim() })),
  }
}

/** Create / edit a plan, with a live preview of the card customers will see. */
export function PlanFormDialog({
  plan,
  planType,
  open,
  onOpenChange,
}: {
  plan: Plan | null
  planType: PlanType
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('plans')
  const tCommon = useTranslations('common')
  const tUsage = useTranslations('subscription.usage.types')
  const locale = useLocale()
  const [form, setForm] = useState<FormState>(() => toForm(plan, planType))
  const [previewLang, setPreviewLang] = useState<'ar' | 'en'>(locale === 'en' ? 'en' : 'ar')
  const [previewCycle, setPreviewCycle] = useState<BillingCycle>('monthly')
  const [errorField, setErrorField] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm((f) => ({ ...f, [key]: value }))

  function submit(e: React.FormEvent) {
    e.preventDefault()
    setErrorField(null)
    startTransition(async () => {
      const input = toInput(form)
      const result = plan ? await updatePlan(plan.id, input) : await createPlan(input)
      if (result.ok) {
        toast.success(t(plan ? 'toast.updated' : 'toast.created'))
        onOpenChange(false)
        return
      }
      setErrorField(result.field ?? null)
      toast.error(
        result.error === 'validation' && result.field
          ? t('errors.invalidField', { field: t.has(`form.fields.${result.field}`) ? t(`form.fields.${result.field}`) : result.field })
          : t(`errors.${result.error}`)
      )
    })
  }

  const invalid = (field: string) => (errorField === field ? true : undefined)
  const previewPrice = Number(previewCycle === 'yearly' ? form.price_yearly : form.price_monthly) || 0

  return (
    <Dialog open={open} onOpenChange={(next) => !isPending && onOpenChange(next)}>
      <DialogContent className="max-h-[92vh] overflow-y-auto sm:max-w-5xl">
        <form onSubmit={submit} className="grid gap-6">
          <DialogHeader>
            <DialogTitle>{plan ? t('form.editTitle') : t('form.addTitle')}</DialogTitle>
            <DialogDescription>{t('form.description')}</DialogDescription>
          </DialogHeader>

          <div className="grid gap-8 lg:grid-cols-[1fr_320px]">
            <div className="grid content-start gap-5">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="grid gap-2">
                  <Label htmlFor="plan-name-ar">{t('form.fields.name_ar')} *</Label>
                  <Input id="plan-name-ar" dir="rtl" value={form.name_ar} onChange={(e) => set('name_ar', e.target.value)} maxLength={80} required aria-invalid={invalid('name_ar')} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-name">{t('form.fields.name')} *</Label>
                  <Input id="plan-name" dir="ltr" value={form.name} onChange={(e) => set('name', e.target.value)} maxLength={80} required aria-invalid={invalid('name')} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-slug">{t('form.fields.slug')} *</Label>
                  <Input
                    id="plan-slug"
                    dir="ltr"
                    value={form.slug}
                    onChange={(e) => set('slug', e.target.value.toLowerCase())}
                    placeholder="business_basic"
                    maxLength={60}
                    required
                    aria-invalid={invalid('slug')}
                  />
                  <p className="text-xs text-muted-foreground">{t('form.hints.slug')}</p>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-type">{t('form.fields.plan_type')}</Label>
                  <Select value={form.plan_type} onValueChange={(value) => set('plan_type', value as PlanType)}>
                    <SelectTrigger id="plan-type" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      {PLAN_TYPES.map((type) => (
                        <SelectItem key={type} value={type}>
                          {t(`types.${type}`)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-price-monthly">{t('form.fields.price_monthly')} *</Label>
                  <Input id="plan-price-monthly" type="number" min={0} step="0.01" dir="ltr" value={form.price_monthly} onChange={(e) => set('price_monthly', e.target.value)} required aria-invalid={invalid('price_monthly')} />
                </div>
                <div className="grid gap-2">
                  <Label htmlFor="plan-price-yearly">{t('form.fields.price_yearly')} *</Label>
                  <Input id="plan-price-yearly" type="number" min={0} step="0.01" dir="ltr" value={form.price_yearly} onChange={(e) => set('price_yearly', e.target.value)} required aria-invalid={invalid('price_yearly')} />
                </div>
              </div>

              <fieldset className="grid gap-3">
                <legend className="mb-1 text-sm font-medium">{t('form.limits')}</legend>
                <p className="-mt-1 text-xs text-muted-foreground">{t('form.hints.unlimited')}</p>
                <div className="grid gap-4 sm:grid-cols-3">
                  {LIMIT_TYPES.map((type) => {
                    const column = LIMIT_COLUMNS[type]
                    return (
                      <div key={type} className="grid gap-2">
                        <Label htmlFor={`plan-${column}`}>{tUsage(type)}</Label>
                        <Input
                          id={`plan-${column}`}
                          type="number"
                          min={0}
                          step={1}
                          dir="ltr"
                          value={form[column]}
                          onChange={(e) => set(column, e.target.value)}
                          placeholder={t('unlimited')}
                          aria-invalid={invalid(column)}
                        />
                      </div>
                    )
                  })}
                </div>
              </fieldset>

              <div className="grid gap-2">
                <Label>{t('form.fields.features')}</Label>
                <FeaturesEditor features={form.features} onChange={(features) => set('features', features)} />
              </div>

              <div className="flex items-center gap-3">
                <Switch id="plan-active" checked={form.is_active} onCheckedChange={(checked) => set('is_active', checked)} />
                <Label htmlFor="plan-active">{t('form.fields.is_active')}</Label>
              </div>
            </div>

            <aside className="grid content-start gap-3 lg:sticky lg:top-0">
              <div className="flex items-center justify-between gap-2">
                <span className="text-sm font-medium">{t('form.preview')}</span>
                <div className="flex gap-1">
                  <Tabs value={previewLang} onValueChange={(v) => setPreviewLang(v as 'ar' | 'en')}>
                    <TabsList className="h-8">
                      <TabsTrigger value="ar" className="text-xs">ع</TabsTrigger>
                      <TabsTrigger value="en" className="text-xs">EN</TabsTrigger>
                    </TabsList>
                  </Tabs>
                  <Tabs value={previewCycle} onValueChange={(v) => setPreviewCycle(v as BillingCycle)}>
                    <TabsList className="h-8">
                      <TabsTrigger value="monthly" className="text-xs">{t('form.previewMonthly')}</TabsTrigger>
                      <TabsTrigger value="yearly" className="text-xs">{t('form.previewYearly')}</TabsTrigger>
                    </TabsList>
                  </Tabs>
                </div>
              </div>
              {/* Card text follows the preview language; its direction too */}
              <div dir={previewLang === 'ar' ? 'rtl' : 'ltr'} lang={previewLang} className="pt-3">
                <PlanCard
                  name={(previewLang === 'ar' ? form.name_ar : form.name) || t('form.untitled')}
                  features={form.features.map((f) => f[previewLang]).filter(Boolean)}
                  price={previewPrice}
                  cycle={previewCycle}
                  inactive={!form.is_active}
                  action={
                    <Button type="button" className="w-full" tabIndex={-1}>
                      {t('form.previewButton')}
                    </Button>
                  }
                />
              </div>
              <p className="text-xs text-muted-foreground">{t('form.hints.preview')}</p>
            </aside>
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={isPending}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={isPending}>
              {isPending ? tCommon('loading') : tCommon('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
