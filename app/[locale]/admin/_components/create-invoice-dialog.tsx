'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Loader2, Plus } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { dateKeyToIso, toDateKey } from '@/components/billing/date-key'
import { createInvoice, getInvoiceDefaults } from '@/lib/actions/admin-subscriptions'

/**
 * Manual invoice. Picking an organization fills in its effective price
 * (custom pricing applied) and the period after its current one.
 */
export function CreateInvoiceDialog({
  organizations,
  organizationId: fixedOrganizationId,
}: {
  organizations: { id: string; name: string }[]
  /** Set on an organization's page: no picker */
  organizationId?: string
}) {
  const t = useTranslations('invoices')
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [organizationId, setOrganizationId] = useState(fixedOrganizationId ?? '')
  const [amount, setAmount] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [status, setStatus] = useState<'draft' | 'sent'>('sent')
  const [notes, setNotes] = useState('')
  const [loadingDefaults, setLoadingDefaults] = useState(false)
  const [isPending, startTransition] = useTransition()

  // Prefill from the organization's subscription (on open / when picked)
  function loadDefaults(id: string) {
    setLoadingDefaults(true)
    getInvoiceDefaults(id)
      .then((defaults) => {
        if (!defaults) return
        setAmount(String(defaults.amount))
        setPeriodStart(toDateKey(defaults.periodStart))
        setPeriodEnd(toDateKey(defaults.periodEnd))
      })
      .finally(() => setLoadingDefaults(false))
  }

  function pickOrganization(id: string) {
    setOrganizationId(id)
    loadDefaults(id)
  }

  function clearForm() {
    setOrganizationId(fixedOrganizationId ?? '')
    setAmount('')
    setPeriodStart('')
    setPeriodEnd('')
    setStatus('sent')
    setNotes('')
  }

  function handleOpenChange(next: boolean) {
    if (isPending) return
    setOpen(next)
    if (!next) clearForm()
    else if (fixedOrganizationId) loadDefaults(fixedOrganizationId)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await createInvoice({
        organization_id: organizationId,
        amount: Number(amount),
        period_start: dateKeyToIso(periodStart),
        period_end: dateKeyToIso(periodEnd),
        status,
        notes: notes.trim() || null,
      })
      if (result.ok) {
        toast.success(t('toast.created'))
        setOpen(false)
        clearForm()
      } else {
        toast.error(result.error === 'validation' && result.field === 'period_end' ? t('errors.period') : t(`errors.${result.error}`))
      }
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Plus />
          {t('create')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t('createTitle')}</DialogTitle>
            <DialogDescription>{t('createDescription')}</DialogDescription>
          </DialogHeader>

          {!fixedOrganizationId && (
            <div className="grid gap-2">
              <Label htmlFor="invoice-org">{t('fields.organization')}</Label>
              <Select value={organizationId} onValueChange={pickOrganization}>
                <SelectTrigger id="invoice-org" className="w-full">
                  <SelectValue placeholder={t('placeholders.organization')} />
                </SelectTrigger>
                <SelectContent>
                  {organizations.map((org) => (
                    <SelectItem key={org.id} value={org.id}>
                      {org.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}

          <div className="grid gap-2">
            <Label htmlFor="invoice-amount" className="flex items-center gap-2">
              {t('fields.amountEgp')}
              {loadingDefaults && <Loader2 className="size-3.5 animate-spin text-muted-foreground" />}
            </Label>
            <Input
              id="invoice-amount"
              type="number"
              min={0}
              step="0.01"
              dir="ltr"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              required
            />
            <p className="text-xs text-muted-foreground">{t('hints.amount')}</p>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="invoice-start">{t('fields.periodStart')}</Label>
              <Input id="invoice-start" type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} required />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="invoice-end">{t('fields.periodEnd')}</Label>
              <Input id="invoice-end" type="date" value={periodEnd} min={periodStart} onChange={(e) => setPeriodEnd(e.target.value)} required />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="invoice-status">{t('fields.status')}</Label>
            <Select value={status} onValueChange={(v) => setStatus(v as 'draft' | 'sent')}>
              <SelectTrigger id="invoice-status" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="sent">{t('status.sent')}</SelectItem>
                <SelectItem value="draft">{t('status.draft')}</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="invoice-notes">{t('fields.notes')}</Label>
            <Textarea id="invoice-notes" value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={500} rows={2} />
          </div>

          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => handleOpenChange(false)} disabled={isPending}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" disabled={isPending || !organizationId || !amount || !periodStart || !periodEnd}>
              {isPending ? tCommon('loading') : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
