import { z } from 'zod'
import { cairoParts, cairoWallTimeToIso, CAIRO_TZ } from '@/lib/cairo-time'
import type { JsonSchema } from '@/lib/ai/providers/types'
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
  year: optionalInt(2000, 2100),
  hour: optionalInt(0, 23),
  minute: optionalInt(0, 59),
  period: z.enum(PERIODS).catch('unspecified'),
  needs_team_check: z.boolean().nullish().catch(null),
})

/** What the visitor said about when, as the model reported it */
export type AppointmentRequest = z.infer<typeof appointmentRequestSchema>

// Structured-output schema of the components (JSON Schema; each provider
// translates it). The same one wherever an appointment is read: the reply
// call, and the analysis of messages the bot didn't answer.
export const APPOINTMENT_REQUEST_SCHEMA: JsonSchema = {
  type: ['object', 'null'],
  properties: {
    day_type: { type: 'string', enum: DAY_TYPES },
    weekday: { type: ['string', 'null'], enum: WEEKDAYS },
    day_of_month: { type: ['integer', 'null'] },
    month: { type: ['integer', 'null'] },
    year: { type: ['integer', 'null'] },
    hour: { type: ['integer', 'null'] },
    minute: { type: ['integer', 'null'] },
    period: { type: 'string', enum: PERIODS },
    needs_team_check: { type: ['boolean', 'null'] },
  },
  required: ['day_type', 'period'],
}

// What the visitor's latest message gave of their own details, as written
export const CONTACT_REPORT_SCHEMA: JsonSchema = {
  type: ['object', 'null'],
  properties: {
    name: { type: ['string', 'null'] },
    phone: { type: ['string', 'null'] },
  },
}

export const BOT_REPLY_SCHEMA: JsonSchema = {
  type: 'object',
  properties: {
    // "contact" and "appointment" BEFORE "reply", on purpose: do not reorder
    // or sort these. The model writes the properties in this order, so it
    // settles what the visitor gave first and then writes the reply already
    // knowing it. With the reply first, the text could claim a booking that
    // the appointment written after it never backed up (the bug fixed in
    // September 2026).
    contact: CONTACT_REPORT_SCHEMA,
    appointment: APPOINTMENT_REQUEST_SCHEMA,
    // With an appointment reported, the only text of the model's that is
    // sent: its answer to something else the same message asked
    other_answer: { type: ['string', 'null'] },
    reply: { type: 'string' },
  },
  required: ['reply'],
}

export const botReplySchema = z.object({
  // Empty is expected with an appointment: the model is told its reply is not
  // sent on that turn, and leaves it out (parseBotReply)
  reply: z.string().nullish().catch(null),
  other_answer: z.string().nullish().catch(null),
  appointment: appointmentRequestSchema.nullish().catch(null),
  contact: z
    .object({ name: z.string().nullish().catch(null), phone: z.string().nullish().catch(null) })
    .nullish()
    .catch(null),
})

/** How to report an appointment as components: shared by every prompt that reads one */
export const APPOINTMENT_COMPONENTS = `- When the visitor's latest message asks for, agrees to or changes an appointment with a specific day and time, fill "appointment" with what THEY said, as components. Report, don't calculate: no dates worked out from "tomorrow" or a weekday, no 24-hour conversion, and no guessing a part of the day they didn't say.
  day_type: today (النهارده), tomorrow (بكرة), day_after_tomorrow (بعد بكرة), weekday (a named day: set "weekday"), date (a calendar date: set "day_of_month", "month" if stated, and "year" only if they said a year), or none.
  hour and minute exactly as said ("الساعة 6" → 6; "11 ونص" → 11 and 30). period: morning (الصبح), noon (الضهر), afternoon (العصر), evening (المغرب), night (بالليل / العشا), or unspecified when they didn't say.
- A new time without a day ("خليها 7") is day_type none with the new hour: the day they already chose is kept. Always the visitor's latest choice.
- When the latest message only completes what they asked before (answering which part of the day, or which hour), report the whole request: the day and hour from earlier with what they just added.
- needs_team_check: true when the information you were given says the business is closed or unavailable at that time (a holiday, a doctor who is away), or you cannot tell whether it can be honoured. Report the request all the same: the system decides what becomes of it.`

/** Where the reply states what is on record; replaced from the lead row */
export const SAVED_PHONE_PLACEHOLDER = '{{saved_phone}}'
export const SAVED_NAME_PLACEHOLDER = '{{saved_name}}'

/** The instructions that go with BOT_REPLY_SCHEMA in the system prompt */
export const APPOINTMENT_INSTRUCTIONS = `Answer as JSON with "contact", "appointment", "other_answer" and "reply" (your message to the visitor).

The visitor's details ("contact", null when the latest message gives none):
- name: the name the visitor gave for themselves in their LATEST message, copied exactly as they wrote it. phone: the phone number they gave in their LATEST message, every digit as written, even if it looks wrong or incomplete. Report, don't judge and don't correct: the system checks them and tells the visitor itself when one is not usable.
- You cannot see what has been saved, but the system can. Never say that a name or a number was received, saved, recorded, registered or updated, and never write the visitor's phone number in "reply". When the visitor asks what is on record ("سجلت رقمي؟"), or you want to state it, answer with the placeholder — ${SAVED_PHONE_PLACEHOLDER} for the phone number, ${SAVED_NAME_PLACEHOLDER} for the name, as in "رقمك المسجّل عندنا ${SAVED_PHONE_PLACEHOLDER}" — and never by saying that you can't see it: the system replaces the placeholder with what is actually stored, or says that nothing is.

Appointments ("appointment"):
${APPOINTMENT_COMPONENTS}
- Whenever "appointment" is not null, the SYSTEM writes everything the visitor is told about it: whether it is recorded, confirmed, refused, outside working hours, or still needs their name or number. Your "reply" is NOT shown to the visitor on that turn, so nothing you think about the time — that it is fine, that it is not possible, that another time would be better — reaches them or should be written anywhere else.
- "other_answer": when the same message ALSO asked about something that is not the appointment (a price, insurance, an address, a doctor), answer that here, and only that. Nothing about the appointment, its day or time, opening hours as a reason, or whether it can be booked. Null when the message asked nothing else, and null whenever "appointment" is null, unless you are told below that a time the visitor asked for earlier is held.
- When "appointment" is null and you mention an appointment the visitor already has, write ${APPOINTMENT_PLACEHOLDER} in "reply" exactly where its day and time belong, and never write the day or the time yourself: the system replaces it with the appointment on record. Never say that something is booked or confirmed yourself.
- With no specific day ("next week", "soon", "any time") or no time at all, "appointment" is null: don't use ${APPOINTMENT_PLACEHOLDER}, and ask for the missing day or time.
- "appointment" is null whenever the latest message isn't about scheduling.`

/**
 * Added to the prompt while a time the visitor asked for earlier is held on
 * the lead for their name or number (confirmPending): the system may book or
 * refuse it on this message without the model reporting anything, and then
 * the reply is not sent either, so the rest of the answer has to be in
 * "other_answer" already.
 */
export const HELD_REQUEST_INSTRUCTIONS = `A day and time the visitor asked for earlier is held until their name and phone number are both on record. The system may book or refuse it on this message, and then your "reply" is NOT shown to the visitor: the system says what became of it. So whenever "appointment" is null, also write in "other_answer" your answer to everything in the latest message that is not about that appointment (a greeting, a question, what you still need from them), with nothing about the appointment, its day or time, or whether it can be booked; null when there is nothing else to say. "reply" is written as usual.`

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

/** A day of the business's week: closed, or open between two wall-clock times */
export type OpeningDay = { weekday: number; open: false } | { weekday: number; open: true; from: string; to: string }

export type AppointmentResolution =
  | {
      status: 'resolved'
      /** The instant, as UTC ISO */
      at: string
      /** The hour was chosen from a part of the day ("Thursday morning") */
      approximate: boolean
      /**
       * Code checked the time against the business's opening hours. False
       * when the business has set none: the time is then a request that only
       * a person can accept, never one the assistant confirms by itself.
       */
      validated: boolean
    }
  /** "at 9" with nothing to say whether morning or evening: the visitor has to be asked */
  | { status: 'ask_period'; hour: number }
  /** A real day and time, when the business is closed; `hours` is that day's */
  | { status: 'outside_hours'; hours: OpeningDay }
  /** A real day and time that has already gone */
  | { status: 'past' }
  /** No usable day and time, or an implausible one */
  | { status: 'none' }

const NONE: AppointmentResolution = { status: 'none' }
const PAST: AppointmentResolution = { status: 'past' }

/**
 * Whether the business is open at an instant, and that day's hours.
 *
 * INTERIM (October 2026): `hours` is bot_settings.business_hours, one
 * schedule for the whole business. A business with branches has one per
 * branch: for the demo clinic this is right for المعادي and wrong for التجمع
 * (which opens an hour later and is closed on Fridays). It stops a patient
 * being told to come at 5 in the morning, which is what it is here for;
 * per-branch hours come with the branches table.
 */
export function openingAt(hours: BusinessHours, at: string | Date): { open: boolean; day: OpeningDay } {
  const wall = cairoParts(at)
  const weekday = new Date(Date.UTC(wall.year, wall.month, wall.day)).getUTCDay()
  const [hour, minute] = wall.time.split(':').map(Number)
  const schedule = hours.days[HOURS_DAY[weekday]]
  return {
    open: isOpenAt(hours, weekday, hour, minute),
    day: schedule.open ? { weekday, open: true, from: schedule.from, to: schedule.to } : { weekday, open: false },
  }
}

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
      if (request.day_of_month && request.year) {
        // A year the visitor stated is taken as said, never moved: a date
        // that has gone is refused, not rolled to next year
        const month = request.month ? request.month - 1 : today.month
        const candidate = new Date(Date.UTC(request.year, month, request.day_of_month))
        if (candidate.getUTCDate() !== request.day_of_month) return NONE
        if (candidate.getTime() < Date.UTC(today.year, today.month, today.day)) return PAST
        day = { year: candidate.getUTCFullYear(), month: candidate.getUTCMonth(), day: candidate.getUTCDate() }
      } else if (request.day_of_month) {
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

  if (Number.isNaN(at.getTime())) return NONE
  // An hour of slack for "today at 5" said just after 5
  if (at.getTime() < now.getTime() - HOUR_MS) return PAST
  if (at.getTime() > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) return NONE
  if (businessHours?.enabled) {
    const opening = openingAt(businessHours, at)
    if (!opening.open) return { status: 'outside_hours', hours: opening.day }
  }
  return { status: 'resolved', at: at.toISOString(), approximate, validated: businessHours?.enabled === true }
}

/**
 * Whether the assistant confirms an appointment itself: only when the client
 * lets it (auto-confirm) and code checked the time against opening hours.
 * Anything else is a request the team confirms — the reply then says so, and
 * never "confirmed".
 *
 * Code's decision alone. The model's needs_team_check is its report about
 * itself, and that has been wrong both ways: no flag on a refusal it wrote
 * (GT07), the flag on a time inside opening hours (GT08, 13 October 2026).
 * It is kept on the lead for the team (ai_appointment.needs_team_check) and
 * never decides what the visitor reads.
 */
export const confirmsItself = (autoConfirm: boolean, validated: boolean) => autoConfirm && validated

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
const LOCALES = { ar: 'ar-EG-u-nu-latn', en: 'en-GB' } as const

/** "12:00 ظهراً" / "12:00 PM" from a wall-clock "HH:MM" */
function formatClock(time: string, language: ReplyLanguage) {
  const t = TEXTS[language]
  const [hours, minutes] = time.split(':').map(Number)
  const dayPart = hours < 12 ? t.am : hours < 15 ? t.noon : t.pm
  return `${hours % 12 || 12}:${pad(minutes)} ${dayPart}`
}

/** That day's opening hours, in words: what a refused time is answered with */
function describeOpening(day: OpeningDay, language: ReplyLanguage) {
  const t = TEXTS[language]
  // 4 January 1970 was a Sunday: index = Date#getDay()
  const name = new Intl.DateTimeFormat(LOCALES[language], { weekday: 'long', timeZone: 'UTC' }).format(
    new Date(Date.UTC(1970, 0, 4 + day.weekday))
  )
  if (!day.open) return t.closedDay.replace('{day}', name)
  return t.outsideHours
    .replace('{day}', name)
    .replace('{from}', formatClock(day.from, language))
    .replace('{to}', formatClock(day.to, language))
}

/** "الخميس 8 أكتوبر الساعة 6:00 مساءً" / "Thursday 8 October at 6:00 PM", in Cairo time */
export function formatAppointment(at: string, language: ReplyLanguage): string {
  const t = TEXTS[language]
  const date = new Date(at)
  // Latin digits in Arabic too, as visitors write them
  const locale = LOCALES[language]
  const part = (options: Intl.DateTimeFormatOptions) =>
    new Intl.DateTimeFormat(locale, { timeZone: CAIRO_TZ, ...options }).format(date)
  const time = formatClock(cairoParts(date).time, language)
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
  /**
   * Not an appointment yet: the time is kept as a request until the visitor's
   * name and phone number are both on record. `handoff`: the bot has stopped
   * asking for the phone number, a person completes it.
   */
  | { status: 'needs_details'; at: string; missing: ('name' | 'phone')[]; handoff: boolean }
  /** Nothing recorded: the business is closed then */
  | { status: 'outside_hours'; hours: OpeningDay }
  /** Nothing recorded: that day and time have gone */
  | { status: 'past' }
  /** Nothing recorded: no usable day and time, or the booking failed */
  | { status: 'none' }

// Splits a reply after each sentence
const SENTENCE_END = /(?<=[.!?؟…\n])/

/**
 * The model's text without the sentences that hold the placeholder. With no
 * appointment on record those sentences state a booking that didn't happen;
 * the rest (an answer to another question in the same message) is still true.
 */
function withoutAppointmentSentences(template: string) {
  return template
    .split(SENTENCE_END)
    .filter((sentence) => !sentence.includes(APPOINTMENT_PLACEHOLDER))
    .join('')
    .trim()
}

/** The appointment on record, in the system's own words: confirmed, or a request the team confirms */
function bookedLine(outcome: Extract<BookingOutcome, { status: 'booked' }>, language: ReplyLanguage) {
  const t = TEXTS[language]
  return (outcome.confirmed ? t.bookedConfirmed : t.bookedRequest).replace('{time}', formatAppointment(outcome.at, language))
}

/**
 * Everything the visitor is told about the appointment they asked for, in
 * the system's words, whatever became of it. Used alone on a turn where the
 * model reported an appointment: nothing the model wrote about it is sent.
 *
 * The model can't be asked what its own text says. In the eval of 13 October
 * 2026 it refused a time that was fine, ended the refusal on the appointment
 * placeholder and reported no doubt about the time, so one reply said the
 * time was outside working hours and then "موعدك مؤكَّد ✅" (GT07). The
 * decision is code's, so the sentence is code's, in both directions.
 */
export function appointmentLine(outcome: BookingOutcome, language: ReplyLanguage): string {
  const t = TEXTS[language]
  switch (outcome.status) {
    case 'booked':
      return bookedLine(outcome, language)
    case 'kept':
      return t.kept.replace('{time}', formatAppointment(outcome.at, language))
    case 'ask_period':
      return t.askPeriod.replace('{hour}', String(outcome.hour))
    case 'outside_hours':
      return describeOpening(outcome.hours, language)
    case 'past':
      return t.past
    case 'needs_details': {
      const time = formatAppointment(outcome.at, language)
      return outcome.handoff
        ? t.needDetailsHandoff.replace('{time}', time)
        : t.needDetails
            .replace('{time}', time)
            .replace('{missing}', outcome.missing.map((field) => (field === 'name' ? t.missingName : t.missingPhone)).join(t.and))
    }
    case 'none':
      // No usable day and time in what was reported, or the booking failed
      return t.askTime
  }
}

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
  if (outcome.status === 'none') {
    if (!hasPlaceholder) return template
    // Nothing was booked: keep what else the model said, and ask for the day
    // and time instead of the booking it claimed
    const rest = withoutAppointmentSentences(template)
    return rest ? `${rest}\n${t.askTime}` : t.askTime
  }
  // Refused, or not an appointment yet: what the model wrote about the
  // booking goes, the rest of its answer stays, and code says why
  if (outcome.status === 'outside_hours' || outcome.status === 'past' || outcome.status === 'needs_details') {
    const rest = withoutAppointmentSentences(template)
    const said = appointmentLine(outcome, language)
    return rest ? `${rest}\n${said}` : said
  }

  const time = formatAppointment(outcome.at, language)
  if (!outcome.changed && !hasPlaceholder) return template
  const status = outcome.confirmed ? t.confirmed : t.pending
  // A time asked for earlier became the appointment on this message, which
  // was about something else: the model's answer, then the system's sentence
  if (!hasPlaceholder) return [template, bookedLine(outcome, language)].filter(Boolean).join('\n')

  // Whether it is confirmed goes right after the sentence that states the
  // appointment, before anything the reply goes on to ask: "…6:00 مساءً.
  // موعدك مؤكَّد ✅ ممكن رقم موبايلك؟" reads as settled, then the question
  const sentences = template.split(SENTENCE_END)
  const last = sentences.findLastIndex((sentence) => sentence.includes(APPOINTMENT_PLACEHOLDER))
  const fill = (part: string[]) => part.join('').replaceAll(APPOINTMENT_PLACEHOLDER, time).trim()
  const rest = fill(sentences.slice(last + 1))
  return [fill(sentences.slice(0, last + 1)), status, rest].filter(Boolean).join('\n')
}
