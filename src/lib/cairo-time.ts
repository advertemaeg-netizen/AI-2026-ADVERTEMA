import { TZDate } from '@date-fns/tz'
import { addDays, startOfDay } from 'date-fns'

/** Every date in the product is shown and reasoned about in Cairo time. */
export const CAIRO_TZ = 'Africa/Cairo'

const pad = (n: number) => String(n).padStart(2, '0')

/** Start of a Cairo calendar day, `offsetDays` from today (or from `from`). */
export function cairoDayStart(offsetDays = 0, from: Date = new Date()): Date {
  return new Date(startOfDay(addDays(new TZDate(from, CAIRO_TZ), offsetDays)).getTime())
}

/** Cairo wall-clock date + "HH:MM" → the real instant, as UTC ISO (DST-aware). */
export function cairoWallTimeToIso(year: number, monthIndex: number, day: number, time: string): string {
  const [hours, minutes] = time.split(':').map(Number)
  return new Date(new TZDate(year, monthIndex, day, hours || 0, minutes || 0, CAIRO_TZ).getTime()).toISOString()
}

/** The Cairo calendar date and "HH:MM" of an instant. */
export function cairoParts(value: string | Date) {
  const d = new TZDate(new Date(value).getTime(), CAIRO_TZ)
  return {
    year: d.getFullYear(),
    month: d.getMonth(),
    day: d.getDate(),
    time: `${pad(d.getHours())}:${pad(d.getMinutes())}`,
    dateKey: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`,
  }
}

/** "Thursday 2026-10-01 17:30" in Cairo — context for the AI. */
export function describeCairoNow(now: Date = new Date()) {
  const d = new TZDate(now.getTime(), CAIRO_TZ)
  const weekday = new Intl.DateTimeFormat('en-US', { weekday: 'long', timeZone: CAIRO_TZ }).format(now)
  const { dateKey, time } = cairoParts(d)
  return `${weekday} ${dateKey} ${time}`
}
