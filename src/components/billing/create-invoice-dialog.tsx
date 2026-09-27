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
import { createInvoice, getInvoiceDefaults } from '@/lib/actions/admin-subscriptions'
import { createClientInvoice, getClientInvoiceDefaults } from '@/lib/actions/agency-billing'
import type { BilledTo, InvoiceInput } from '@/lib/types/subscription'
import { dateKeyToIso, toDateKey } from './date-key'

type Values = Omit<InvoiceInput, 'organization_id'>

// platform: a super admin bills an organization; agency: an agency bills one of its clients
const PARTIES = {
  platform: {
    defaults: getInvoiceDefaults,
    create: (id: string, values: Values) => createInvoice({ organization_id: id, ...values }),
  },
  agency: {
    defaults: getClientInvoiceDefaults,
    create: (id: string, values: Values) => createClientInvoice({ client_id: id, ...values }),
  },
} as const

/**
 * Manual invoice. Picking who it's for fills in their effective price
 * (custom pricing applied) and the period after their current one.
 */
export function CreateInvoiceDialog({
  billedTo = 'platform',
  parties,
  partyId: fixedPartyId,
  trigger,
}: {
  billedTo?: BilledTo
  /** Organizations (platform) or the agency's clients (agency) to pick from */
  parties: { id: string; name: string }[]
  /** Set on one organization's / client's page: no picker */
  partyId?: string
  /** Replaces the default "New invoice" button */
  trigger?: React.ReactNode
}) {
  const t = useTranslations('invoices')
  const tCommon = useTranslations('common')
  const actions = PARTIES[billedTo]
  const agency = billedTo === 'agency'
  const [open, setOpen] = useState(false)
  const [partyId, setPartyId] = useState(fixedPartyId ?? '')
  const [amount, setAmount] = useState('')
  const [periodStart, setPeriodStart] = useState('')
  const [periodEnd, setPeriodEnd] = useState('')
  const [status, setStatus] = useState<'draft' | 'sent'>('sent')
  const [notes, setNotes] = useState('')
  const [loadingDefaults, setLoadingDefaults] = useState(false)
  const [isPending, startTransition] = useTransition()

  // Prefill from the subscription (on open / when picked)
  function loadDefaults(id: string) {
    setLoadingDefaults(true)
    actions
      .defaults(id)
      .then((defaults) => {
        if (!defaults) return
        setAmount(String(defaults.amount))
        setPeriodStart(toDateKey(defaults.periodStart))
        setPeriodEnd(toDateKey(defaults.periodEnd))
      })
      .finally(() => setLoadingDefaults(false))
  }

  function pickParty(id: string) {
    setPartyId(id)
    loadDefaults(id)
  }

  function clearForm() {
    setPartyId(fixedPartyId ?? '')
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
    else if (fixedPartyId) loadDefaults(fixedPartyId)
  }

  function submit(e: React.FormEvent) {
    e.preventDefault()
    startTransition(async () => {
      const result = await actions.create(partyId, {
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
        {trigger ?? (
          <Button>
            <Plus />
            {t('create')}
          </Button>
        )}
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit} className="grid gap-4">
          <DialogHeader>
            <DialogTitle>{t(agency ? 'createTitleClient' : 'createTitle')}</DialogTitle>
            <DialogDescription>{t(agency ? 'createDescriptionClient' : 'createDescription')}</DialogDescription>
          </DialogHeader>

          {!fixedPartyId && (
            <div className="grid gap-2">
              <Label htmlFor="invoice-party">{t(agency ? 'fields.client' : 'fields.organization')}</Label>
              <Select value={partyId} onValueChange={pickParty}>
                <SelectTrigger id="invoice-party" className="w-full">
                  <SelectValue placeholder={t(agency ? 'placeholders.client' : 'placeholders.organization')} />
                </SelectTrigger>
                <SelectContent>
                  {parties.map((party) => (
                    <SelectItem key={party.id} value={party.id}>
                      {party.name}
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
            <p className="text-xs text-muted-foreground">{t(agency ? 'hints.amountClient' : 'hints.amount')}</p>
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
            <Button type="submit" disabled={isPending || !partyId || !amount || !periodStart || !periodEnd}>
              {isPending ? tCommon('loading') : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
