'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Ban, CheckCircle2, MoreHorizontal, Send, TimerOff } from 'lucide-react'
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
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { markInvoicePaid, setInvoiceStatus } from '@/lib/actions/admin-subscriptions'
import { PAYMENT_METHODS, type Invoice, type InvoiceStatus, type PaymentMethod } from '@/lib/types/subscription'
import { dateKeyToIso, toDateKey } from './date-key'
import { useMoney } from './use-money'

/** Super admin actions on one invoice: mark paid, mark sent / overdue, cancel. */
export function InvoiceRowActions({ invoice }: { invoice: Invoice }) {
  const t = useTranslations('invoices')
  const [paying, setPaying] = useState(false)
  const [isPending, startTransition] = useTransition()

  if (invoice.status === 'paid' || invoice.status === 'cancelled') return null

  function changeStatus(status: Exclude<InvoiceStatus, 'paid'>) {
    startTransition(async () => {
      const result = await setInvoiceStatus(invoice.id, status)
      if (result.ok) toast.success(t('toast.statusChanged'))
      else toast.error(t(`errors.${result.error}`))
    })
  }

  return (
    <>
      <DropdownMenu modal={false}>
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label={t('actions.label')} disabled={isPending}>
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setPaying(true)}>
            <CheckCircle2 />
            {t('actions.markPaid')}
          </DropdownMenuItem>
          {invoice.status === 'draft' && (
            <DropdownMenuItem onSelect={() => changeStatus('sent')}>
              <Send />
              {t('actions.markSent')}
            </DropdownMenuItem>
          )}
          {invoice.status === 'sent' && (
            <DropdownMenuItem onSelect={() => changeStatus('overdue')}>
              <TimerOff />
              {t('actions.markOverdue')}
            </DropdownMenuItem>
          )}
          <DropdownMenuItem variant="destructive" onSelect={() => changeStatus('cancelled')}>
            <Ban />
            {t('actions.cancel')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      {paying && <MarkPaidDialog invoice={invoice} onClose={() => setPaying(false)} />}
    </>
  )
}

function MarkPaidDialog({ invoice, onClose }: { invoice: Invoice; onClose: () => void }) {
  const t = useTranslations('invoices')
  const tCommon = useTranslations('common')
  const money = useMoney()
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer')
  const [reference, setReference] = useState('')
  const [paidOn, setPaidOn] = useState(() => toDateKey(new Date()))
  const [isPending, startTransition] = useTransition()

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await markInvoicePaid(invoice.id, {
        payment_method: method,
        payment_reference: reference.trim() || null,
        paid_at: dateKeyToIso(paidOn, '12:00'),
      })
      if (result.ok) {
        toast.success(t('toast.paid', { number: invoice.invoice_number }))
        onClose()
      } else {
        toast.error(t(`errors.${result.error}`))
      }
    })
  }

  return (
    <Dialog open onOpenChange={(open) => !open && !isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('markPaid.title', { number: invoice.invoice_number })}</DialogTitle>
            <DialogDescription>
              {t('markPaid.description', { amount: money.withCurrency(invoice.amount) })}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="payment-method">{t('fields.paymentMethod')}</Label>
            <Select value={method} onValueChange={(value) => setMethod(value as PaymentMethod)}>
              <SelectTrigger id="payment-method" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PAYMENT_METHODS.map((m) => (
                  <SelectItem key={m} value={m}>
                    {t(`methods.${m}`)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="payment-reference">{t('fields.paymentReference')}</Label>
            <Input
              id="payment-reference"
              value={reference}
              onChange={(e) => setReference(e.target.value)}
              maxLength={120}
              placeholder={t('placeholders.paymentReference')}
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="paid-on">{t('fields.paidAt')}</Label>
            <Input id="paid-on" type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} required />
          </div>

          <p className="text-xs text-muted-foreground">{t('markPaid.hint')}</p>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={isPending || !paidOn}>
              {isPending ? tCommon('loading') : t('actions.markPaid')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
