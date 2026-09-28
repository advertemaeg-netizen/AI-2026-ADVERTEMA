'use client'

import { useState, useTransition } from 'react'
import { useFormatter, useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { ArrowLeftRight } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { setUsdToEgp } from '@/lib/actions/ai-usage'

/** The USD → EGP rate used for every EGP cost and margin on the platform. */
export function ExchangeRateButton({ rate }: { rate: number }) {
  const t = useTranslations('aiUsage.exchangeRate')
  const tCommon = useTranslations('common')
  const format = useFormatter()
  const [open, setOpen] = useState(false)
  const [value, setValue] = useState(String(rate))
  const [isPending, startTransition] = useTransition()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await setUsdToEgp(Number(value))
      if (result.ok) {
        toast.success(t('saved'))
        setOpen(false)
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (isPending) return
        setOpen(next)
        if (next) setValue(String(rate))
      }}
    >
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <ArrowLeftRight data-icon="inline-start" />
          {t('button', { rate: format.number(rate) })}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('title')}</DialogTitle>
            <DialogDescription>{t('description')}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="usd-to-egp">{t('label')}</Label>
            <Input
              id="usd-to-egp"
              type="number"
              min={0.01}
              step="0.01"
              dir="ltr"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              required
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
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
