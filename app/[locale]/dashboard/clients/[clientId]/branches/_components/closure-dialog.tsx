'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { CalendarOff } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Checkbox } from '@/components/ui/checkbox'
import { Input } from '@/components/ui/input'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { Field, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { addClosuresAction } from '@/lib/actions/branches'
import { CLOSURE_REASON_MAX, closureInputSchema, type Branch } from '@/lib/types/branches'

/** Today in the branch's own time zone, as YYYY-MM-DD */
const today = (timezone: string) => new Intl.DateTimeFormat('en-CA', { timeZone: timezone }).format(new Date())

export function ClosureDialog({
  clientId,
  branch,
  branches,
}: {
  clientId: string
  /** The branch the dialog was opened from: chosen to start with */
  branch: Branch
  /** Every branch of the client: a public holiday closes them all */
  branches: Pick<Branch, 'id' | 'name'>[]
}) {
  const t = useTranslations('branches')
  const tCommon = useTranslations('common')
  const [open, setOpen] = useState(false)
  const [isSaving, startSaving] = useTransition()
  const start = today(branch.timezone)
  const [from, setFrom] = useState(start)
  const [to, setTo] = useState(start)
  const [reason, setReason] = useState('')
  const [chosen, setChosen] = useState<string[]>([branch.id])
  const [errors, setErrors] = useState<Record<string, string>>({})

  function handleOpenChange(next: boolean) {
    if (isSaving) return
    if (next) {
      setFrom(start)
      setTo(start)
      setReason('')
      setChosen([branch.id])
      setErrors({})
    }
    setOpen(next)
  }

  const toggle = (id: string, on: boolean) => setChosen((ids) => (on ? [...new Set([...ids, id])] : ids.filter((x) => x !== id)))

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const input = { from, to, reason, branchIds: chosen }
    const parsed = closureInputSchema.safeParse(input)
    if (!parsed.success) {
      const next: Record<string, string> = {}
      for (const issue of parsed.error.issues) next[String(issue.path[0] ?? 'form')] ??= issue.message
      setErrors(next)
      return
    }
    startSaving(async () => {
      const result = await addClosuresAction(clientId, parsed.data)
      if (result.ok) {
        toast.success(t('toast.closuresAdded', { count: result.added ?? 0 }))
        setOpen(false)
        return
      }
      setErrors(result.fieldErrors ?? {})
      toast.error(t(`errors.${result.error}`))
    })
  }

  const errorText = (key: string) => (errors[key] ? t(`fieldErrors.${errors[key]}`) : undefined)

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <CalendarOff data-icon="inline-start" />
          {t('closures.add')}
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={handleSubmit} className="grid gap-4" noValidate>
          <DialogHeader>
            <DialogTitle>{t('closures.addTitle')}</DialogTitle>
            <DialogDescription>{t('closures.addDescription')}</DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <div className="grid grid-cols-2 gap-3">
              <Field data-invalid={!!errors.from}>
                <FieldLabel htmlFor="closure-from">{t('closures.from')}</FieldLabel>
                <Input
                  id="closure-from"
                  type="date"
                  dir="ltr"
                  value={from}
                  onChange={(e) => {
                    setFrom(e.target.value)
                    if (to < e.target.value) setTo(e.target.value)
                  }}
                />
                <FieldError>{errorText('from')}</FieldError>
              </Field>
              <Field data-invalid={!!errors.to}>
                <FieldLabel htmlFor="closure-to">{t('closures.to')}</FieldLabel>
                <Input id="closure-to" type="date" dir="ltr" min={from} value={to} onChange={(e) => setTo(e.target.value)} />
                <FieldError>{errorText('to')}</FieldError>
              </Field>
            </div>

            <Field data-invalid={!!errors.reason}>
              <FieldLabel htmlFor="closure-reason">{t('closures.reason')}</FieldLabel>
              <Input
                id="closure-reason"
                value={reason}
                maxLength={CLOSURE_REASON_MAX}
                placeholder={t('closures.reasonPlaceholder')}
                onChange={(e) => setReason(e.target.value)}
              />
              <FieldError>{errorText('reason')}</FieldError>
            </Field>

            {branches.length > 1 && (
              <Field data-invalid={!!errors.branchIds}>
                <FieldLabel>{t('closures.branches')}</FieldLabel>
                <label className="flex items-center gap-2 text-sm">
                  <Checkbox
                    checked={chosen.length === branches.length}
                    onCheckedChange={(on) => setChosen(on === true ? branches.map((b) => b.id) : [branch.id])}
                  />
                  {t('closures.allBranches')}
                </label>
                <div className="grid gap-1.5 ps-6">
                  {branches.map((b) => (
                    <label key={b.id} className="flex items-center gap-2 text-sm">
                      <Checkbox checked={chosen.includes(b.id)} onCheckedChange={(on) => toggle(b.id, on === true)} />
                      {b.name}
                    </label>
                  ))}
                </div>
                <FieldError>{errorText('branchIds')}</FieldError>
              </Field>
            )}
          </FieldGroup>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSaving}>
                {tCommon('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? tCommon('loading') : t('closures.create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
