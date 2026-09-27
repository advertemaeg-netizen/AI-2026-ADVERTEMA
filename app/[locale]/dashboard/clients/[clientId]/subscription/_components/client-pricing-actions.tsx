'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Tag, TagsIcon } from 'lucide-react'
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
import { CustomPricingDialog } from '@/components/billing/custom-pricing-dialog'
import { removeClientCustomPricing, setClientCustomPricing } from '@/lib/actions/client-subscription'

/** The agency's "custom price" button (and removing it) for one client. */
export function ClientPricingActions({
  clientId,
  clientName,
  basePrice,
  hasCustomPricing,
}: {
  clientId: string
  clientName: string
  basePrice: { monthly: number; yearly: number }
  hasCustomPricing: boolean
}) {
  const t = useTranslations('clientSubscription.pricing')
  const tAdmin = useTranslations('subscription.admin')
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState<'set' | 'remove' | null>(null)
  const [isPending, startTransition] = useTransition()

  function remove() {
    startTransition(async () => {
      const result = await removeClientCustomPricing(clientId)
      if (result.ok) {
        toast.success(tAdmin('toast.pricingRemoved'))
        setOpen(null)
      } else {
        toast.error(tAdmin(`errors.${result.error}`))
      }
    })
  }

  return (
    <div className="flex flex-wrap gap-2">
      <Button variant="outline" size="sm" onClick={() => setOpen('set')}>
        <Tag />
        {t('set')}
      </Button>
      {hasCustomPricing && (
        <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setOpen('remove')}>
          <TagsIcon />
          {t('remove')}
        </Button>
      )}

      {open === 'set' && (
        <CustomPricingDialog
          subject="client"
          name={clientName}
          basePrice={basePrice}
          hasCustomPricing={hasCustomPricing}
          save={(input) => setClientCustomPricing(clientId, input)}
          onClose={() => setOpen(null)}
        />
      )}

      <AlertDialog open={open === 'remove'} onOpenChange={(next) => !next && !isPending && setOpen(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('removeTitle', { name: clientName })}</AlertDialogTitle>
            <AlertDialogDescription>{t('removeDescription')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>{tCommon('cancel')}</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={isPending}
              onClick={(e) => {
                e.preventDefault()
                remove()
              }}
            >
              {isPending ? tCommon('loading') : t('remove')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}
