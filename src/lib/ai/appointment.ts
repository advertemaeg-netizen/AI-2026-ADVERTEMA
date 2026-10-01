import { z } from 'zod'
import { cairoParts, cairoWallTimeToIso, CAIRO_TZ } from '@/lib/cairo-time'
import type { BotLanguage, BusinessHours, WeekDay } from '@/lib/types/bot-settings'
import ar from '../../../messages/ar.json'
import en from '../../../messages/en.json'

/**
 * The one place an appointment is worked out. The chat model only reports
 * what the visitor said, as components (which day, which hour, which part of
 * the day); everything that needs arithmetic or a rule — the calendar date,
 * the 24-hour clock, the Cairo offset — happens here, the same way every
 * time. The reply then quotes the stored result through a placeholder, so it
 * cannot disagree with the record.
 */

/** Where the reply's day and time go; replaced with the stored appointment */
export const APPOINTMENT_PLACEHOLDER = '{{appointment}}'

const DAY_TYPES = ['none', 'today', 'tomorrow', 'day_after_tomorrow', 'weekday', 'date'] as const
// Index = Date#getDay()
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'] as const
const PERIODS = ['unspecified', 'morning', 'noon', 'afternoon', 'evening', 'night'] as const
type Period = (typeof PERIODS)[number]

const optionalInt = (min: number, max: number) =>
  z
    .number()
    .nullish()
    .transform((v) => (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : null))

export const appointmentRequestSchema = z.object({
  day_type: z.enum(DAY_TYPES).catch('none'),
  weekday: z.enum(WEEKDAYS).nullish().catch(null),
  day_of_month: optionalInt(1, 31),
  month: optionalInt(1, 12),
  hour: optionalInt(0, 23),
  minute: optionalInt(0, 59),
  period: z.enum(PERIODS).catch('unspecified'),
})

/** What the visitor said about when, as the model reported it */
export type AppointmentRequest = z.infer<typeof appointmentRequestSchema>

// Gemini structured-output schema (OpenAPI subset) of the components. The
// same one wherever an appointment is read: the reply call, and the analysis
// of messages the bot didn't answer.
export const APPOINTMENT_REQUEST_SCHEMA = {
  type: 'OBJECT',
  nullable: true,
  properties: {
    day_type: { type: 'STRING', enum: DAY_TYPES },
    weekday: { type: 'STRING', enum: WEEKDAYS, nullable: true },
    day_of_month: { type: 'INTEGER', nullable: true },
    month: { type: 'INTEGER', nullable: true },
    hour: { type: 'INTEGER', nullable: true },
    minute: { type: 'INTEGER', nullable: true },
    period: { type: 'STRING', enum: PERIODS },
  },
  required: ['day_type', 'period'],
}

export const BOT_REPLY_SCHEMA = {
  type: 'OBJECT',
  properties: {
    reply: { type: 'STRING' },
    appointment: APPOINTMENT_REQUEST_SCHEMA,
  },
  required: ['reply'],
  propertyOrdering: ['appointment', 'reply'],
}

export const botReplySchema = z.object({
  reply: z.string().trim().min(1),
  appointment: appointmentRequestSchema.nullish().catch(null),
})

/** How to report an appointment as components: shared by every prompt that reads one */
export const APPOINTMENT_COMPONENTS = `- When the visitor's latest message asks for, agrees to or changes an appointment with a specific day and time, fill "appointment" with what THEY said, as components. Report, don't calculate: no dates worked out from "tomorrow" or a weekday, no 24-hour conversion, and no guessing a part of the day they didn't say.
  day_type: today (النهارده), tomorrow (بكرة), day_after_tomorrow (بعد بكرة), weekday (a named day: set "weekday"), date (a calendar date: set "day_of_month", and "month" if stated), or none.
  hour and minute exactly as said ("الساعة 6" → 6; "11 ونص" → 11 and 30). period: morning (الصبح), noon (الضهر), afternoon (العصر), evening (المغرب), night (بالليل / العشا), or unspecified when they didn't say.
- A new time without a day ("خليها 7") is day_type none with the new hour: the day they already chose is kept. Always the visitor's latest choice.
- When the latest message only completes what they asked before (answering which part of the day, or which hour), report the whole request: the day and hour from earlier with what they just added.`

/** The instructions that go with BOT_REPLY_SCHEMA in the system prompt */
export const APPOINTMENT_INSTRUCTIONS = `Appointments. Answer as JSON with "reply" (your message to the visitor) and "appointment".
${APPOINTMENT_COMPONENTS}
- In "reply", write ${APPOINTMENT_PLACEHOLDER} exactly where the appointment's day and time belong, and never write the day or the time yourself: the system replaces it with the appointment it recorded, and adds whether it is confirmed. Don't say that it is confirmed or that someone will confirm it.
- With no specific day ("next week", "soon", "any time") or no time at all, "appointment" is null: don't use ${APPOINTMENT_PLACEHOLDER}, and ask for the missing day or time.
- "appointment" is null whenever the latest message isn't about scheduling.`

// With only a part of the day, a usual hour for it (flagged as approximate)
const PERIOD_DEFAULT_HOUR: Record<Exclude<Period, 'unspecified'>, number> = {
  morning: 10,
  noon: 13,
  afternoon: 16,
  evening: 19,
  night: 21,
}

/** The hour on the 24-hour clock; 24 and up run past midnight into the next day. */
function to24Hour(hour: number, period: Period): number {
  if (hour >= 13) return hour
  switch (period) {
    case 'morning':
      return hour
    case 'noon':
      // "1 الضهر" is 13:00; "11 الضهر" stays before noon
      return hour <= 4 ? hour + 12 : hour
    case 'afternoon':
    case 'evening':
      return hour === 12 ? 12 : hour + 12
    case 'night':
      // "12 بالليل" is midnight, "2 بالليل" the small hours after it
      if (hour === 12 || hour === 0) return 24
      return hour <= 4 ? hour + 24 : hour + 12
    case 'unspecified':
      // Only reached for hours that read one way (0, 13 and up)
      return hour
  }
}

// Index = Date#getDay()
const HOURS_DAY: WeekDay[] = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']

/** Whether the business is open at that wall-clock time on that day */
function isOpenAt(hours: BusinessHours, weekday: number, hour: number, minute: number) {
  const day = hours.days[HOURS_DAY[weekday]]
  if (!day.open) return false
  const time = `${pad(hour)}:${pad(minute)}`
  // A closing time at or before the opening time is after midnight. The small
  // hours of such a night don't count: "tomorrow at 1" could be either end of
  // the day, so it is asked about rather than settled here.
  return day.to > day.from ? time >= day.from && time < day.to : time >= day.from
}

// How far ahead an appointment may be; anything else is a misread
const MAX_DAYS_AHEAD = 180
const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

type CalendarDay = { year: number; month: number; day: number }

/** Calendar arithmetic on a Cairo date, free of any clock or offset */
function addDays({ year, month, day }: CalendarDay, days: number): CalendarDay {
  const d = new Date(Date.UTC(year, month, day + days))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth(), day: d.getUTCDate() }
}

const weekdayOf = ({ year, month, day }: CalendarDay) => new Date(Date.UTC(year, month, day)).getUTCDay()

const pad = (n: number) => String(n).padStart(2, '0')

export type AppointmentResolution =
  | {
      status: 'resolved'
      /** The instant, as UTC ISO */
      at: string
      /** The hour was chosen from a part of the day ("Thursday morning") */
      approximate: boolean
    }
  /** "at 9" with nothing to say whether morning or evening: the visitor has to be asked */
  | { status: 'ask_period'; hour: number }
  /** No usable day and time, or an implausible one */
  | { status: 'none' }

const NONE: AppointmentResolution = { status: 'none' }

/**
 * Components → the instant in Cairo time. Nothing is ever guessed to fill a
 * gap: without a day and a time there is no appointment ('none'), and an hour
 * that could be morning or evening is settled only by the business's opening
 * hours — when exactly one of the two falls inside them. Otherwise
 * ('ask_period') the visitor is asked.
 * `keepDayOf`: the appointment already on record, whose day a time-only
 * change keeps.
 */
export function resolveAppointment(
  request: AppointmentRequest,
  {
    now = new Date(),
    keepDayOf = null,
    businessHours = null,
  }: { now?: Date; keepDayOf?: string | null; businessHours?: BusinessHours | null } = {}
): AppointmentResolution {
  const today: CalendarDay = cairoParts(now)

  let day: CalendarDay | null = null
  switch (request.day_type) {
    case 'today':
      day = today
      break
    case 'tomorrow':
      day = addDays(today, 1)
      break
    case 'day_after_tomorrow':
      day = addDays(today, 2)
      break
    case 'weekday':
      if (request.weekday) {
        // Its next occurrence; today counts (a time already gone moves it a week, below)
        day = addDays(today, (WEEKDAYS.indexOf(request.weekday) - weekdayOf(today) + 7) % 7)
      }
      break
    case 'date':
      if (request.day_of_month) {
        // No month: this month's, or next month's once that day has passed
        const month = request.month ? request.month - 1 : today.month + (request.day_of_month < today.day ? 1 : 0)
        const candidate = new Date(Date.UTC(today.year, month, request.day_of_month))
        // "31" in a 30-day month, or a date already gone this year
        if (candidate.getUTCDate() !== request.day_of_month) return NONE
        if (candidate.getTime() < Date.UTC(today.year, today.month, today.day)) {
          candidate.setUTCFullYear(candidate.getUTCFullYear() + 1)
        }
        day = { year: candidate.getUTCFullYear(), month: candidate.getUTCMonth(), day: candidate.getUTCDate() }
      }
      break
    case 'none':
      if (keepDayOf && request.hour !== null) day = cairoParts(keepDayOf)
      break
  }
  if (!day) return NONE

  let hour: number
  let approximate = false
  if (request.hour !== null && request.period === 'unspecified' && request.hour >= 1 && request.hour <= 12) {
    // "الساعة 9": morning or evening? Whichever one the business is open for
    const morning = request.hour % 12
    const open = businessHours?.enabled
      ? [morning, morning + 12].filter((h) => isOpenAt(businessHours, weekdayOf(day), h, request.minute ?? 0))
      : []
    if (open.length !== 1) return { status: 'ask_period', hour: request.hour }
    hour = open[0]
  } else if (request.hour !== null) {
    hour = to24Hour(request.hour, request.period)
  } else if (request.period !== 'unspecified') {
    hour = PERIOD_DEFAULT_HOUR[request.period]
    approximate = true
  } else {
    return NONE
  }

  const instant = (d: CalendarDay) => {
    const onDay = addDays(d, Math.floor(hour / 24))
    return new Date(cairoWallTimeToIso(onDay.year, onDay.month, onDay.day, `${pad(hour % 24)}:${pad(request.minute ?? 0)}`))
  }
  let at = instant(day)
  if (request.day_type === 'weekday' && at.getTime() < now.getTime()) at = instant(addDays(day, 7))

  // An hour of slack for "today at 5" said just after 5
  if (Number.isNaN(at.getTime()) || at.getTime() < now.getTime() - HOUR_MS) return NONE
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) return NONE
  return { status: 'resolved', at: at.toISOString(), approximate }
}

/** Same instant? (Postgres and JS format timestamps differently) */
export function sameInstant(a: string | null | undefined, b: string | null | undefined) {
  return !!a && !!b && new Date(a).getTime() === new Date(b).getTime()
}

export type ReplyLanguage = 'ar' | 'en'

/** The language the system's own sentences use: the bot's, or the visitor's when it speaks both */
export function replyLanguage(language: BotLanguage, lastUserMessage: string): ReplyLanguage {
  if (language !== 'both') return language
  return /[؀-ۿ]/.test(lastUserMessage) ? 'ar' : 'en'
}

const TEXTS = { ar: ar.botReplies.appointment, en: en.botReplies.appointment }

/** "الخميس 8 أكتوبر الساعة 6:00 مساءً" / "Thursday 8 October at 6:00 PM", in Cairo time */
export function formatAppointment(at: string, language: ReplyLanguage): string {
  const t = TEXTS[language]
  const date = new Date(at)
  // Latin digits in Arabic too, as visitors write them
  const locale = language === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB'
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone: CAIRO_TZ, ...options }).format(date)
  const [hours, minutes] = cairoParts(date).time.split(':').map(Number)
  const dayPart = hours < 12 ? t.am : hours < 15 ? t.noon : t.pm
  const time = `${hours % 12 || 12}:${pad(minutes)} ${dayPart}`
  return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'long' })} ${t.at} ${time}`
}

/** What happened to the appointment the visitor asked for */
export type BookingOutcome =
  /** On record at `at`. `changed`: this message set or moved it */
  | { status: 'booked'; at: string; confirmed: boolean; changed: boolean }
  /** The team's own time stays; the request was not applied */
  | { status: 'kept'; at: string }
  /** Nothing recorded yet: morning or evening has to be asked */
  | { status: 'ask_period'; hour: number }
  /** Nothing recorded: no usable day and time, or the booking failed */
  | { status: 'none' }

/**
 * The reply as the visitor gets it. The model's text never states the time:
 * the placeholder is filled with the appointment that is actually on record,
 * and whether it is confirmed is said here, from the record, not by the model.
 */
export function renderReply(template: string, outcome: BookingOutcome, language: ReplyLanguage): string {
  const t = TEXTS[language]
  const hasPlaceholder = template.includes(APPOINTMENT_PLACEHOLDER)

  if (outcome.status === 'kept') return t.kept.replace('{time}', formatAppointment(outcome.at, language))
  // Whatever the model wrote, nothing is booked until this is answered
  if (outcome.status === 'ask_period') return t.askPeriod.replace('{hour}', String(outcome.hour))
  if (outcome.status === 'none') return hasPlaceholder ? t.askTime : template

  const time = formatAppointment(outcome.at, language)
  if (!outcome.changed && !hasPlaceholder) return template
  const text = hasPlaceholder
    ? template.replaceAll(APPOINTMENT_PLACEHOLDER, time)
    : `${template}\n${t.noted.replace('{time}', time)}`
  return `${text}\n${outcome.confirmed ? t.confirmed : t.pending}`
}
