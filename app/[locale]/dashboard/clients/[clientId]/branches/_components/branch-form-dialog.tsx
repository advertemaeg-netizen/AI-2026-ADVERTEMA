'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { toast } from 'sonner'
import { Plus, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Field, FieldContent, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createBranchAction, updateBranchAction } from '@/lib/actions/branches'
import { BOT_TIMEZONES, WEEK_DAYS, type WeekDay } from '@/lib/types/bot-settings'
import {
  BRANCH_NAME_MAX,
  CAPACITY_MAX,
  DEFAULT_BRANCH_INPUT,
  RANGES_PER_DAY_MAX,
  SLOT_MINUTES,
  branchInputSchema,
  uniformWeek,
  type Branch,
  type BranchHours,
  type BranchInput,
} from '@/lib/types/branches'

/** The week a branch starts from when its hours are first turned on */
const STARTING_WEEK = uniformWeek('09:00', '17:00', ['fri'])

/** zod issue paths, joined: "name", "business_hours.sat.0" */
function issuesByPath(issues: { path: PropertyKey[]; message: string }[]) {
  const errors: Record<string, string> = {}
  for (const issue of issues) errors[issue.path.map(String).join('.') || 'form'] ??= issue.message
  return errors
}

export function BranchFormDialog({
  clientId,
  branch,
  open,
  onOpenChange,
}: {
  clientId: string
  /** Absent: a new branch */
  branch?: Branch
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const t = useTranslations('branches')
  const tCommon = useTranslations('common')
  const [isSaving, startSaving] = useTransition()
  const initial: BranchInput = branch
    ? {
        name: branch.name,
        timezone: branch.timezone,
        capacity_per_slot: branch.capacity_per_slot,
        slot_minutes: branch.slot_minutes,
        business_hours: branch.business_hours,
        is_active: branch.is_active,
      }
    : DEFAULT_BRANCH_INPUT
  const [values, setValues] = useState<BranchInput>(initial)
  // Kept while the hours are switched off, so switching them back restores them
  const [lastHours, setLastHours] = useState<BranchHours>(initial.business_hours ?? STARTING_WEEK)
  const [errors, setErrors] = useState<Record<string, string>>({})

  const set = <K extends keyof BranchInput>(key: K, value: BranchInput[K]) => setValues((v) => ({ ...v, [key]: value }))
  const errorText = (key: string) => (errors[key] ? t(`fieldErrors.${errors[key]}`) : undefined)

  function handleOpenChange(next: boolean) {
    if (isSaving) return
    if (next) {
      setValues(initial)
      setLastHours(initial.business_hours ?? STARTING_WEEK)
      setErrors({})
    }
    onOpenChange(next)
  }

  function setHours(hours: BranchHours) {
    setLastHours(hours)
    set('business_hours', hours)
  }

  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const parsed = branchInputSchema.safeParse(values)
    if (!parsed.success) {
      setErrors(issuesByPath(parsed.error.issues))
      return
    }
    startSaving(async () => {
      const result = branch ? await updateBranchAction(branch.id, parsed.data) : await createBranchAction(clientId, parsed.data)
      if (result.ok) {
        const done = branch ? t('toast.saved') : t('toast.created')
        toast.success(result.linkedLeads ? `${done} ${t('toast.linked', { count: result.linkedLeads })}` : done)
        onOpenChange(false)
        return
      }
      setErrors(result.fieldErrors ?? {})
      if (!result.fieldErrors?.name) toast.error(t(`errors.${result.error}`))
    })
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={handleSubmit} className="grid gap-5" noValidate>
          <DialogHeader>
            <DialogTitle>{branch ? t('editTitle', { name: branch.name }) : t('addTitle')}</DialogTitle>
            <DialogDescription>{t('formDescription')}</DialogDescription>
          </DialogHeader>

          <FieldGroup>
            <Field data-invalid={!!errors.name}>
              <FieldLabel htmlFor="branch-name">{t('fields.name')} *</FieldLabel>
              <Input
                id="branch-name"
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
                placeholder={t('placeholders.name')}
                maxLength={BRANCH_NAME_MAX}
                aria-invalid={!!errors.name}
              />
              <FieldError>{errorText('name')}</FieldError>
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field data-invalid={!!errors.capacity_per_slot}>
                <FieldLabel htmlFor="branch-capacity">{t('fields.capacity')}</FieldLabel>
                <Input
                  id="branch-capacity"
                  type="number"
                  dir="ltr"
                  min={1}
                  max={CAPACITY_MAX}
                  value={Number.isNaN(values.capacity_per_slot) ? '' : values.capacity_per_slot}
                  onChange={(e) => set('capacity_per_slot', e.target.valueAsNumber)}
                  aria-invalid={!!errors.capacity_per_slot}
                />
                <FieldDescription>{t('hints.capacity')}</FieldDescription>
                <FieldError>{errorText('capacity_per_slot')}</FieldError>
              </Field>

              <Field>
                <FieldLabel htmlFor="branch-slot">{t('fields.slotMinutes')}</FieldLabel>
                <Select
                  value={String(values.slot_minutes)}
                  onValueChange={(v) => set('slot_minutes', Number(v) as BranchInput['slot_minutes'])}
                >
                  <SelectTrigger id="branch-slot" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {SLOT_MINUTES.map((minutes) => (
                      <SelectItem key={minutes} value={String(minutes)}>
                        {t('slot', { minutes })}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>

              <Field>
                <FieldLabel htmlFor="branch-timezone">{t('fields.timezone')}</FieldLabel>
                <Select value={values.timezone} onValueChange={(v) => set('timezone', v as BranchInput['timezone'])}>
                  <SelectTrigger id="branch-timezone" className="w-full" dir="ltr">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {BOT_TIMEZONES.map((zone) => (
                      <SelectItem key={zone} value={zone}>
                        {zone}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </Field>
            </div>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="branch-active">{t('fields.active')}</FieldLabel>
                <FieldDescription>{t('hints.inactive')}</FieldDescription>
              </FieldContent>
              <Switch id="branch-active" checked={values.is_active} onCheckedChange={(on) => set('is_active', on)} />
            </Field>

            <Field orientation="horizontal">
              <FieldContent>
                <FieldLabel htmlFor="branch-hours">{t('fields.hoursSet')}</FieldLabel>
                <FieldDescription>{t('hints.hoursNotSet')}</FieldDescription>
              </FieldContent>
              <Switch
                id="branch-hours"
                checked={values.business_hours !== null}
                onCheckedChange={(on) => set('business_hours', on ? lastHours : null)}
              />
            </Field>

            {values.business_hours && <WeekEditor hours={values.business_hours} onChange={setHours} errors={errors} />}
          </FieldGroup>

          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline" disabled={isSaving}>
                {tCommon('cancel')}
              </Button>
            </DialogClose>
            <Button type="submit" disabled={isSaving}>
              {isSaving ? tCommon('loading') : branch ? t('save') : t('create')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function WeekEditor({
  hours,
  onChange,
  errors,
}: {
  hours: BranchHours
  onChange: (hours: BranchHours) => void
  errors: Record<string, string>
}) {
  const t = useTranslations('branches')
  const tDays = useTranslations('botSettings')
  const setDay = (day: WeekDay, ranges: BranchHours[WeekDay]) => onChange({ ...hours, [day]: ranges })

  return (
    <div className="grid gap-2">
      {WEEK_DAYS.map((day) => {
        const ranges = hours[day]
        const open = ranges.length > 0
        // The day's own error, or the first one of its ranges
        const errorKey = Object.keys(errors).find((key) => key === `business_hours.${day}` || key.startsWith(`business_hours.${day}.`))
        return (
          <div key={day} className="grid gap-2 rounded-lg border px-3 py-2">
            <div className="flex flex-wrap items-center gap-3">
              <label className="flex w-36 items-center gap-2 text-sm">
                <Switch
                  checked={open}
                  aria-label={`${tDays(`days.${day}`)} — ${t('hours.openDay')}`}
                  onCheckedChange={(on) => setDay(day, on ? [['09:00', '17:00']] : [])}
                />
                {tDays(`days.${day}`)}
              </label>
              {!open && <span className="text-sm text-muted-foreground">{t('hours.closed')}</span>}
              {open && (
                <div className="flex flex-wrap items-center gap-2">
                  {ranges.map(([from, to], i) => (
                    <div key={i} className="flex items-center gap-1.5 text-sm">
                      <span className="text-muted-foreground">{t('hours.from')}</span>
                      <Input
                        type="time"
                        dir="ltr"
                        className="w-28"
                        value={from}
                        onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? [e.target.value, r[1]] : r)))}
                      />
                      <span className="text-muted-foreground">{t('hours.to')}</span>
                      <Input
                        type="time"
                        dir="ltr"
                        className="w-28"
                        value={to}
                        onChange={(e) => setDay(day, ranges.map((r, j) => (j === i ? [r[0], e.target.value] : r)))}
                      />
                      {ranges.length > 1 && (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon-sm"
                          aria-label={t('hours.removeRange')}
                          onClick={() => setDay(day, ranges.filter((_, j) => j !== i))}
                        >
                          <X />
                        </Button>
                      )}
                    </div>
                  ))}
                  {ranges.length < RANGES_PER_DAY_MAX && (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      onClick={() => setDay(day, [...ranges, ['17:00', '21:00']])}
                    >
                      <Plus data-icon="inline-start" />
                      {t('hours.addRange')}
                    </Button>
                  )}
                </div>
              )}
            </div>
            {/* Said out loud: "22:00 to 13:00" is a valid range, open all night */}
            {ranges
              .filter(([from, to]) => to < from)
              .map(([from, to]) => (
                <p key={`${from}-${to}`} className="text-xs text-warning">
                  {t('hours.overnightRange', { from, to })}
                </p>
              ))}
            {errorKey && <p className="text-xs text-destructive">{t(`fieldErrors.${errors[errorKey]}`)}</p>}
          </div>
        )
      })}
      <FieldDescription>{t('hints.overnight')}</FieldDescription>
    </div>
  )
}
