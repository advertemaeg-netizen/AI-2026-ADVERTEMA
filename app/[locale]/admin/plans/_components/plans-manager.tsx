'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowDown, ArrowUp, MoreHorizontal, Pencil, Plus, Power } from 'lucide-react'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useMoney } from '@/components/billing/use-money'
import { reorderPlans, togglePlanActive } from '@/lib/actions/admin-plans'
import { LIMIT_COLUMNS, PLAN_LIMIT_TYPES, PLAN_TYPES, type Plan, type PlanType } from '@/lib/types/subscription'
import { PlanFormDialog } from './plan-form-dialog'

export function PlansManager({ plans, subscribers }: { plans: Plan[]; subscribers: Record<string, number> }) {
  const t = useTranslations('plans')
  const tUsage = useTranslations('subscription.usage.types')
  const locale = useLocale()
  const format = useFormatter()
  const money = useMoney()
  const [tab, setTab] = useState<PlanType>('agency')
  const [editing, setEditing] = useState<{ plan: Plan | null } | null>(null)
  const [isPending, startTransition] = useTransition()

  function move(list: Plan[], index: number, by: -1 | 1) {
    const ids = list.map((p) => p.id)
    const [id] = ids.splice(index, 1)
    ids.splice(index + by, 0, id)
    startTransition(async () => {
      const result = await reorderPlans(tab, ids)
      if (!result.ok) toast.error(t(`errors.${result.error}`))
    })
  }

  function toggle(plan: Plan) {
    startTransition(async () => {
      const result = await togglePlanActive(plan.id)
      if (result.ok) toast.success(t(plan.is_active ? 'toast.deactivated' : 'toast.activated'))
      else toast.error(t(`errors.${result.error}`))
    })
  }

  const limit = (value: number | null) => (value === null ? t('unlimited') : format.number(value))

  return (
    <>
      <Tabs value={tab} onValueChange={(value) => setTab(value as PlanType)} className="gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList>
            {PLAN_TYPES.map((type) => (
              <TabsTrigger key={type} value={type}>
                {t(`tabs.${type}`)}
              </TabsTrigger>
            ))}
          </TabsList>
          <Button onClick={() => setEditing({ plan: null })}>
            <Plus />
            {t('add')}
          </Button>
        </div>

        {PLAN_TYPES.map((type) => {
          const list = plans.filter((p) => p.plan_type === type)
          return (
            <TabsContent key={type} value={type}>
              {list.length === 0 ? (
                <p className="py-10 text-center text-sm text-muted-foreground">{t('empty')}</p>
              ) : (
                <div className="overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead className="w-20">{t('columns.order')}</TableHead>
                        <TableHead>{t('columns.plan')}</TableHead>
                        <TableHead className="text-end">{t('columns.monthly')}</TableHead>
                        <TableHead className="text-end">{t('columns.maxFile')}</TableHead>
                        {PLAN_LIMIT_TYPES[type].map((limitType) => (
                          <TableHead key={limitType} className="text-end">
                            {tUsage(limitType)}
                          </TableHead>
                        ))}
                        <TableHead className="text-end">{t('columns.subscribers')}</TableHead>
                        <TableHead>{t('columns.status')}</TableHead>
                        <TableHead className="w-12">
                          <span className="sr-only">{t('columns.actions')}</span>
                        </TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {list.map((plan, index) => (
                        <TableRow key={plan.id} className={plan.is_active ? undefined : 'opacity-60'}>
                          <TableCell>
                            <div className="flex">
                              <Button variant="ghost" size="icon-sm" disabled={isPending || index === 0} onClick={() => move(list, index, -1)} aria-label={t('moveUp')}>
                                <ArrowUp />
                              </Button>
                              <Button
                                variant="ghost"
                                size="icon-sm"
                                disabled={isPending || index === list.length - 1}
                                onClick={() => move(list, index, 1)}
                                aria-label={t('moveDown')}
                              >
                                <ArrowDown />
                              </Button>
                            </div>
                          </TableCell>
                          <TableCell>
                            <button type="button" className="text-start font-medium hover:underline" onClick={() => setEditing({ plan })}>
                              {locale === 'ar' ? plan.name_ar : plan.name}
                            </button>
                            <div className="text-xs text-muted-foreground" dir="ltr">
                              <span className="block text-start">{plan.slug}</span>
                            </div>
                          </TableCell>
                          <TableCell className="text-end tabular-nums">{money.withCurrency(plan.price_monthly)}</TableCell>
                          <TableCell className="text-end tabular-nums">
                            {plan.max_file_size_mb === null ? '—' : t('mb', { size: plan.max_file_size_mb })}
                          </TableCell>
                          {PLAN_LIMIT_TYPES[type].map((limitType) => (
                            <TableCell key={limitType} className="text-end tabular-nums">
                              {limit(plan[LIMIT_COLUMNS[limitType]])}
                            </TableCell>
                          ))}
                          <TableCell className="text-end tabular-nums">{format.number(subscribers[plan.id] ?? 0)}</TableCell>
                          <TableCell>
                            <Badge variant={plan.is_active ? 'default' : 'secondary'}>
                              {t(plan.is_active ? 'status.active' : 'status.inactive')}
                            </Badge>
                          </TableCell>
                          <TableCell>
                            <DropdownMenu modal={false}>
                              <DropdownMenuTrigger asChild>
                                <Button variant="ghost" size="icon-sm" aria-label={t('columns.actions')}>
                                  <MoreHorizontal />
                                </Button>
                              </DropdownMenuTrigger>
                              <DropdownMenuContent align="end">
                                <DropdownMenuItem onSelect={() => setEditing({ plan })}>
                                  <Pencil />
                                  {t('edit')}
                                </DropdownMenuItem>
                                <DropdownMenuItem onSelect={() => toggle(plan)}>
                                  <Power />
                                  {t(plan.is_active ? 'deactivate' : 'activate')}
                                </DropdownMenuItem>
                              </DropdownMenuContent>
                            </DropdownMenu>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </TabsContent>
          )
        })}
      </Tabs>

      {editing && (
        <PlanFormDialog
          key={editing.plan?.id ?? 'new'}
          plan={editing.plan}
          planType={tab}
          open
          onOpenChange={(open) => !open && setEditing(null)}
        />
      )}
    </>
  )
}
