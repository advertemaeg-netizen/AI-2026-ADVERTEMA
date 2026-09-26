'use client'

import { useState } from 'react'
import { useFormatter, useLocale, useTranslations } from 'next-intl'
import { ar, enUS } from 'react-day-picker/locale'
import { CalendarClock, X } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Calendar } from '@/components/ui/calendar'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { cairoParts, cairoWallTimeToIso } from '@/lib/cairo-time'

/**
 * Picks a day + time as Cairo wall-clock time and reports the real instant
 * (UTC ISO), so it's right even when the browser is in another time zone.
 */
export function CairoDateTimePicker({
  value,
  onSave,
  onClear,
  placeholder,
  disabled,
  defaultTime = '10:00',
  allowPast = false,
}: {
  value: string | null
  onSave: (iso: string) => void
  onClear?: () => void
  placeholder: string
  disabled?: boolean
  defaultTime?: string
  allowPast?: boolean
}) {
  const t = useTranslations('common')
  const format = useFormatter()
  const locale = useLocale()
  const [open, setOpen] = useState(false)

  // The calendar works with plain local dates; only their y/m/d are used
  const initial = value ? cairoParts(value) : null
  const [day, setDay] = useState<Date | undefined>(
    initial ? new Date(initial.year, initial.month, initial.day) : undefined
  )
  const [time, setTime] = useState(initial?.time ?? defaultTime)

  const today = cairoParts(new Date())

  function save() {
    if (!day) return
    onSave(cairoWallTimeToIso(day.getFullYear(), day.getMonth(), day.getDate(), time))
    setOpen(false)
  }

  return (
    <div className="flex gap-2">
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button variant="outline" className="flex-1 justify-start font-normal" disabled={disabled}>
            <CalendarClock data-icon="inline-start" />
            {value ? format.dateTime(new Date(value), { dateStyle: 'medium', timeStyle: 'short' }) : placeholder}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-2" align="start">
          <Calendar
            mode="single"
            selected={day}
            onSelect={setDay}
            locale={locale === 'ar' ? ar : enUS}
            dir={locale === 'ar' ? 'rtl' : 'ltr'}
            disabled={allowPast ? undefined : { before: new Date(today.year, today.month, today.day) }}
          />
          <div className="flex items-center gap-2 border-t p-2">
            <Label htmlFor="cairo-time" className="shrink-0">
              {t('time')}
            </Label>
            <Input
              id="cairo-time"
              type="time"
              dir="ltr"
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="w-28"
            />
            <Button size="sm" className="ms-auto" onClick={save} disabled={!day || !time}>
              {t('save')}
            </Button>
          </div>
        </PopoverContent>
      </Popover>
      {value && onClear && (
        <Button variant="ghost" size="icon" aria-label={t('clear')} onClick={onClear} disabled={disabled}>
          <X />
        </Button>
      )}
    </div>
  )
}
