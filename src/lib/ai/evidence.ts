import type { AppointmentRequest } from '@/lib/ai/appointment'
import { cairoParts } from '@/lib/cairo-time'

/**
 * Nothing the model reports about a booking is taken unless the visitor's own
 * message, on that turn, holds something it could have been read from.
 *
 * The model restates: told to report the whole request when a message only
 * completes it, it sends the day and hour of earlier messages again, and now
 * and then one nobody said (a 5 o'clock for "الأسبوع الجاي"). Code can't tell
 * an invented hour from a remembered one by looking at the model's output, but
 * it can look at what the visitor typed. A part with no trace in the message
 * is dropped; what was really said earlier is in the draft already
 * (mergeDraft), so dropping it costs nothing, and what was never said cannot
 * get in.
 *
 * Fails toward dropping, on purpose: a real time the detector misses means
 * the visitor is asked again; an invented one let through means someone is
 * booked at a time they never chose.
 *
 * An hour needs that number (a numeral or the word for it); a part of the
 * day is evidence for the part of the day only. A day needs that day.
 */

export type EvidencedPart = 'day' | 'hour' | 'minute' | 'period'

/** Latin digits, one spelling per letter, no tashkeel or tatweel, lower case */
function fold(text: string) {
  return text
    .replace(/[٠-٩]/g, (d) => String('٠١٢٣٤٥٦٧٨٩'.indexOf(d)))
    .replace(/[۰-۹]/g, (d) => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(d)))
    .replace(/[ً-ْٰـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي')
    .toLowerCase()
}

// A word on its own (an Arabic prefix و / ب / ال allowed before it)
const word = (alternatives: string[]) =>
  new RegExp(`(?<![\\p{L}])(?:[وب]?(?:ال)?)(?:${alternatives.join('|')})(?![\\p{L}])`, 'u')

const NUMBER_WORDS: [number, string[]][] = [
  [1, ['واحده', 'واحد', 'one']],
  [2, ['اتنين', 'اثنين', 'two']],
  [3, ['تلاته', 'ثلاثه', 'three']],
  [4, ['اربعه', 'رابعه', 'four']],
  [5, ['خمسه', 'خامسه', 'five']],
  [6, ['سته', 'سادسه', 'six']],
  [7, ['سبعه', 'سابعه', 'seven']],
  [8, ['تمانيه', 'ثمانيه', 'ثامنه', 'eight']],
  [9, ['تسعه', 'تاسعه', 'nine']],
  [10, ['عشره', 'عاشره', 'ten']],
  [11, ['حداشر', 'احداشر', 'حاديه عشر', 'eleven']],
  [12, ['اتناشر', 'اثناشر', 'ثانيه عشر', 'twelve']],
]

/** Every hour-sized number the message holds: standalone numerals (not part of a phone number) and number words */
function numbersIn(text: string) {
  const found = new Set<number>()
  for (const m of text.matchAll(/(?<!\d)(\d{1,2})(?::(\d{2}))?(?!\d)/g)) found.add(Number(m[1]))
  for (const [n, words] of NUMBER_WORDS) if (word(words).test(text)) found.add(n)
  return found
}

const MINUTE_WORDS: Record<number, RegExp> = {
  15: /(?<![\p{L}])و ?ربع(?![\p{L}])|quarter past/u,
  20: /(?<![\p{L}])و ?تلت(?![\p{L}])/u,
  30: /(?<![\p{L}])و ?نص(?![\p{L}])|half/u,
  40: /الا ?تلت/u,
  45: /الا ?ربع|quarter to/u,
}
// "7 إلا ربع" is 6:45: the hour said is the next one
const BEFORE_THE_HOUR = /الا ?(?:ربع|تلت)|quarter to/

// The words for each part of the day; a part accepts its neighbours'
const MORNING = ['صبح', 'صباح', 'الصبح', 'صباحا', 'فجر', 'الفجر', 'morning']
const NOON = ['ضهر', 'ظهر', 'الضهر', 'الظهر', 'ظهرا', 'noon']
const AFTERNOON = ['عصر', 'العصر', 'عصرا', 'afternoon']
const EVENING = ['مغرب', 'المغرب', 'مسا', 'مساء', 'مساءا', 'evening']
const NIGHT = ['ليل', 'الليل', 'بالليل', 'عشا', 'العشا', 'عشاء', 'night']
// "am" / "pm" only right after a time: "I am free" is not a morning
const AM = /\d\s*a\.?m\b/
const PM = /\d\s*p\.?m\b/
const PERIOD_WORDS: Record<Exclude<AppointmentRequest['period'], 'unspecified'>, string[]> = {
  morning: MORNING,
  noon: [...NOON, ...AFTERNOON],
  afternoon: [...AFTERNOON, ...NOON, ...EVENING],
  evening: [...EVENING, ...NIGHT, ...AFTERNOON],
  night: [...NIGHT, ...EVENING],
}
// "بعد الظهر" is an afternoon, whatever ظهر alone would say
const AFTER_NOON = /بعد ?ال?[ضظ]هر/

const WEEKDAY_WORDS: Record<NonNullable<AppointmentRequest['weekday']>, string[]> = {
  saturday: ['سبت', 'saturday'],
  // Not a bare "حد" (anyone): "في حد فاضي؟" is not Sunday
  sunday: ['احد', 'الحد', 'sunday'],
  monday: ['اتنين', 'اثنين', 'monday'],
  tuesday: ['تلات', 'تلاتاء', 'ثلاثاء', 'ثلاثا', 'tuesday'],
  wednesday: ['اربع', 'اربعاء', 'اربعا', 'wednesday'],
  thursday: ['خميس', 'thursday'],
  friday: ['جمعه', 'friday'],
}
const MONTHS = [
  ['يناير', 'january', 'jan'],
  ['فبراير', 'february', 'feb'],
  ['مارس', 'march', 'mar'],
  ['ابريل', 'april', 'apr'],
  ['مايو', 'may'],
  ['يونيو', 'june', 'jun'],
  ['يوليو', 'july', 'jul'],
  ['اغسطس', 'august', 'aug'],
  ['سبتمبر', 'september', 'sep'],
  ['اكتوبر', 'october', 'oct'],
  ['نوفمبر', 'november', 'nov'],
  ['ديسمبر', 'december', 'dec'],
]

// "اليوم" with its article only: the bare word for day ("يوم الخميس") doesn't count
const TODAY = /(?<![\p{L}])(?:[وب]?(?:النهارده|انهارده|النهاردا|اليوم|الليله)|today|tonight)(?![\p{L}])/u
const DAY_AFTER = /بعد ?بكر[اه]|day after tomorrow|after tomorrow/
const TOMORROW = /بكر[اه]|tomorrow/

const WEEKDAY_INDEX: Record<NonNullable<AppointmentRequest['weekday']>, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
}

/**
 * The model worked a date out of a day word ("الخميس" → 8 October), which it
 * is told not to do: the date stands if it is exactly the one a day word in
 * the message gives (the coming Thursday, or the one after when today's has
 * gone; tomorrow; today), and not a week off.
 */
function dateFromDayWord(request: AppointmentRequest, text: string, now: Date) {
  const today = cairoParts(now)
  const todayIndex = new Date(Date.UTC(today.year, today.month, today.day)).getUTCDay()
  const offsets: number[] = []
  if (TODAY.test(text)) offsets.push(0)
  if (DAY_AFTER.test(text)) offsets.push(2)
  else if (TOMORROW.test(text)) offsets.push(1)
  for (const [weekday, words] of Object.entries(WEEKDAY_WORDS) as [keyof typeof WEEKDAY_WORDS, string[]][]) {
    if (!word(words).test(text)) continue
    const offset = (WEEKDAY_INDEX[weekday] - todayIndex + 7) % 7
    offsets.push(offset, offset + 7 * Number(offset === 0))
  }
  return offsets.some((offset) => {
    const date = new Date(Date.UTC(today.year, today.month, today.day + offset))
    return (
      date.getUTCDate() === request.day_of_month &&
      (request.month === null || date.getUTCMonth() + 1 === request.month) &&
      (request.year === null || date.getUTCFullYear() === request.year)
    )
  })
}

function dayEvidence(request: AppointmentRequest, text: string, now: Date): boolean {
  switch (request.day_type) {
    case 'none':
      return true
    case 'today':
      return TODAY.test(text)
    case 'tomorrow':
      return TOMORROW.test(text.replace(DAY_AFTER, ''))
    case 'day_after_tomorrow':
      return DAY_AFTER.test(text)
    case 'weekday':
      return request.weekday ? word(WEEKDAY_WORDS[request.weekday]).test(text) : false
    case 'date': {
      const d = request.day_of_month
      if (d === null) return false
      if (dateFromDayWord(request, text, now)) return true
      // The day of the month as a date, not just a number: "25 يناير", "25/1", "يوم 25"
      const months = MONTHS.flat().join('|')
      const asDate = new RegExp(
        `(?<!\\d)${d}\\s*[/\\-.]\\s*\\d{1,2}(?!\\d)|يوم\\s*${d}(?!\\d)|(?<!\\d)${d}\\s*(?:من\\s*)?(?:${months})|(?:${months})\\s*${d}(?!\\d)`
      )
      if (!asDate.test(text)) return false
      const month = request.month
      if (month !== null) {
        const named = word(MONTHS[month - 1]).test(text)
        const numbered = new RegExp(`(?<!\\d)${d}\\s*[/\\-.]\\s*0?${month}(?!\\d)`).test(text)
        if (!named && !numbered) return false
      }
      return request.year === null || new RegExp(`(?<!\\d)${request.year}(?!\\d)`).test(text)
    }
  }
}

/**
 * The request with every part the message gives no evidence for dropped, as
 * if the model had not reported it; and which parts those were.
 */
export function withEvidence(
  request: AppointmentRequest,
  message: string,
  now = new Date()
): { request: AppointmentRequest; dropped: EvidencedPart[] } {
  const text = fold(message)
  const dropped: EvidencedPart[] = []
  const kept = { ...request }

  if (!dayEvidence(request, text, now)) {
    dropped.push('day')
    Object.assign(kept, { day_type: 'none', weekday: null, day_of_month: null, month: null, year: null })
  }

  if (request.hour !== null) {
    const numbers = [...numbersIn(text)]
    // On either clock: "19" said, 7 reported (or the reverse) is the same hour
    const said = (h: number) => numbers.some((n) => n % 12 === h % 12)
    // "7 إلا ربع" reported as 6 and 45
    const beforeTheHour = BEFORE_THE_HOUR.test(text) && said(request.hour + 1)
    if (!said(request.hour) && !beforeTheHour) {
      dropped.push('hour')
      kept.hour = null
    }
  }
  // A minute belongs to an hour that was said
  const minute = request.minute
  if (minute !== null && minute !== 0) {
    const asNumber = new RegExp(`(?<!\\d)(?:\\d{1,2}:)?${String(minute).padStart(2, '0')}(?!\\d)|(?<!\\d)${minute}(?!\\d)`)
    const evidenced = kept.hour !== null && (MINUTE_WORDS[minute]?.test(text) || asNumber.test(text))
    if (!evidenced) {
      dropped.push('minute')
      kept.minute = null
    }
  }

  if (request.period !== 'unspecified') {
    const words = PERIOD_WORDS[request.period]
    const evidenced =
      word(words).test(text) ||
      (request.period === 'morning' ? AM.test(text) : AFTER_NOON.test(text) || PM.test(text))
    if (!evidenced) {
      dropped.push('period')
      kept.period = 'unspecified'
    }
  }
  return { request: kept, dropped }
}
