'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { MoreHorizontal, Power, PowerOff } from 'lucide-react'
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
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { setClientSubscriptionActive } from '@/lib/actions/admin-subscriptions'
import type { SubscriptionStatus } from '@/lib/types/subscription'
import { dateKeyToIso, toDateKey } from './date-key'

const DAY = 24 * 60 * 60 * 1000

/**
 * Super admin: activate or deactivate one client's subscription directly,
 * without an invoice (an agency's client or a direct business). Status and
 * period only; the plan, custom price, invoices and usage stay as they are.
 */
export function ClientActivationActions({
  clientId,
  clientName,
  status,
  variant = 'buttons',
}: {
  clientId: string
  clientName: string
  status: SubscriptionStatus
  /** buttons: a row of buttons (customer page); menu: "…" button (tables) */
  variant?: 'buttons' | 'menu'
}) {
  const t = useTranslations('subscription.admin.activation')
  const tAdmin = useTranslations('subscription.admin')
  const [open, setOpen] = useState<'activate' | 'deactivate' | null>(null)
  // A cancelled subscription has nothing left to deactivate
  const canDeactivate = status !== 'cancelled'

  return (
    <>
      {variant === 'menu' ? (
        <DropdownMenu modal={false}>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={tAdmin('actionsLabel')}>
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setOpen('activate')}>
              <Power />
              {t('activate')}
            </DropdownMenuItem>
            {canDeactivate && (
              <DropdownMenuItem variant="destructive" onSelect={() => setOpen('deactivate')}>
                <PowerOff />
                {t('deactivate')}
              </DropdownMenuItem>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setOpen('activate')}>
            <Power />
            {t('activate')}
          </Button>
          {canDeactivate && (
            <Button variant="ghost" size="sm" className="text-destructive" onClick={() => setOpen('deactivate')}>
              <PowerOff />
              {t('deactivate')}
            </Button>
          )}
        </div>
      )}

      {open && (
        <ActivationDialog
          active={open === 'activate'}
          clientId={clientId}
          clientName={clientName}
          onClose={() => setOpen(null)}
        />
      )}
    </>
  )
}

function ActivationDialog({
  active,
  clientId,
  clientName,
  onClose,
}: {
  active: boolean
  clientId: string
  clientName: string
  onClose: () => void
}) {
  const t = useTranslations('subscription.admin.activation')
  const tAdmin = useTranslations('subscription.admin')
  const tCommon = useTranslations('common')
  const [periodEnd, setPeriodEnd] = useState('')
  const [note, setNote] = useState('')
  const [isPending, startTransition] = useTransition()
  // The end date lies ahead: tomorrow at the earliest (Cairo)
  const [minDate] = useState(() => toDateKey(new Date(Date.now() + DAY)))

  function submit() {
    startTransition(async () => {
      const result = await setClientSubscriptionActive(clientId, {
        active,
        period_end: active && periodEnd ? dateKeyToIso(periodEnd) : null,
        note: note.trim() || null,
      })
      if (result.ok) {
        toast.success(tAdmin(active ? 'toast.activated' : 'toast.deactivated'))
        onClose()
      } else {
        toast.error(tAdmin(`errors.${result.error}`))
      }
    })
  }

  return (
    <Dialog open onOpenChange={(next) => !next && !isPending && onClose()}>
      <DialogContent className="sm:max-w-md">
        <form
          onSubmit={(e) => {
            e.preventDefault()
            submit()
          }}
          className="grid gap-4"
        >
          <DialogHeader>
            <DialogTitle>{t(active ? 'activateTitle' : 'deactivateTitle', { name: clientName })}</DialogTitle>
            <DialogDescription>{t(active ? 'activateDescription' : 'deactivateDescription')}</DialogDescription>
          </DialogHeader>
          {active && (
            <div className="grid gap-2">
              <Label htmlFor="activation-period-end">{t('periodEnd')}</Label>
              <Input
                id="activation-period-end"
                type="date"
                dir="ltr"
                min={minDate}
                value={periodEnd}
                onChange={(e) => setPeriodEnd(e.target.value)}
              />
              <p className="text-xs text-muted-foreground">{t('periodEndHint')}</p>
            </div>
          )}
          <div className="grid gap-2">
            <Label htmlFor="activation-note">{t('note')}</Label>
            <Textarea id="activation-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} rows={2} />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={isPending}>
              {tCommon('cancel')}
            </Button>
            <Button type="submit" variant={active ? 'default' : 'destructive'} disabled={isPending}>
              {isPending ? tCommon('loading') : t(active ? 'activateSubmit' : 'deactivateSubmit')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
