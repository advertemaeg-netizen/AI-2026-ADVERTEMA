/**
 * The hero conversation's appointment, worked out when the page loads (the
 * page itself is static, built once): "tomorrow at 6 PM" from today, in
 * Cairo, written exactly as the product writes an appointment
 * (formatAppointment in src/lib/ai/appointment.ts; tests/site/demo-slot.test.ts
 * holds the two to the same output). Kept apart from that module because
 * this runs in the browser, and the product's module would bring zod and the
 * whole message file with it.
 *
 * The slot must match what the visitor's first line asks for.
 */
export const DEMO_SLOT = { daysFromToday: 1, hour: 18 }

export type ClockWords = { at: string; am: string; noon: string; pm: string }

const LOCALES = { ar: 'ar-EG-u-nu-latn', en: 'en-GB' } as const

/** "الخميس 22 أكتوبر الساعة 6:00 مساءً" / "Thursday 22 October at 6:00 PM" for today + N days in Cairo */
export function demoSlotText(now: Date, language: 'ar' | 'en', words: ClockWords, slot = DEMO_SLOT) {
  // Today's date in Cairo, whatever the visitor's own time zone
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit', day: '2-digit' })
    .formatToParts(now)
    .reduce<Record<string, number>>((acc, p) => (p.type === 'literal' ? acc : { ...acc, [p.type]: Number(p.value) }), {})
  // Midday UTC of that calendar day: formatted in UTC, it is the same day everywhere
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + slot.daysFromToday, 12))
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALES[language], { timeZone: 'UTC', ...options }).format(day)
  const dayPart = slot.hour < 12 ? words.am : slot.hour < 15 ? words.noon : words.pm
  const clock = `${slot.hour % 12 || 12}:00 ${dayPart}`
  return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'long' })} ${words.at} ${clock}`
}
