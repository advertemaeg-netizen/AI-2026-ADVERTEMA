/**
 * The hero conversation's appointment, worked out when the page loads (the
 * page itself is static, built once). The visitor asks for «الخميس ٧ بالليل»,
 * so it is the coming Thursday at 7 PM in Cairo, today included until 7 PM
 * has passed: the same day the product's resolver gives a weekday. It is
 * written exactly as the product writes an appointment (formatAppointment in
 * src/lib/ai/appointment.ts; tests/site/demo-slot.test.ts holds the two to the
 * same output). Kept apart from that module because this runs in the
 * browser, and the product's module would bring zod and the whole message
 * file with it.
 *
 * The slot must match what the visitor's first line asks for.
 */
export const DEMO_SLOT = { weekday: 4, hour: 19 } // Thursday (Date#getDay), 19:00

export type ClockWords = { at: string; am: string; noon: string; pm: string }

const LOCALES = { ar: 'ar-EG-u-nu-latn', en: 'en-GB' } as const

/** "الخميس 22 أكتوبر الساعة 7:00 مساءً" / "Thursday 22 October at 7:00 PM": the next such slot in Cairo */
export function demoSlotText(now: Date, language: 'ar' | 'en', words: ClockWords, slot = DEMO_SLOT) {
  // Now in Cairo, whatever the visitor's own time zone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  })
    .formatToParts(now)
    .reduce<Record<string, number>>((acc, p) => (p.type === 'literal' ? acc : { ...acc, [p.type]: Number(p.value) }), {})
  const todayWeekday = new Date(Date.UTC(parts.year, parts.month - 1, parts.day)).getUTCDay()
  let offset = (slot.weekday - todayWeekday + 7) % 7
  // Today's slot once its hour has gone is next week's
  if (offset === 0 && parts.hour * 60 + parts.minute >= slot.hour * 60) offset = 7
  // Midday UTC of that calendar day: formatted in UTC, it is the same day everywhere
  const day = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + offset, 12))
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALES[language], { timeZone: 'UTC', ...options }).format(day)
  const dayPart = slot.hour < 12 ? words.am : slot.hour < 15 ? words.noon : words.pm
  const clock = `${slot.hour % 12 || 12}:00 ${dayPart}`
  return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'long' })} ${words.at} ${clock}`
}
