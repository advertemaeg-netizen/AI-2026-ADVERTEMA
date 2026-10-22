import { z } from 'zod'
import { cairoParts, cairoWallTimeToIso, CAIRO_TZ } from '@/lib/cairo-time'
import { DAY_ONLY_BOOKING_AR, DAY_ONLY_ORDER_AR, NO_BOOKING_AR } from '@/lib/ai/prompts-ar'
import type { JsonSchema } from '@/lib/ai/providers/types'
import type { BookingMode, BotLanguage, BusinessHours, NameStrictness, WeekDay } from '@/lib/types/bot-settings'
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

// How a day is reported: shared by the appointment and the day-only instructions
const DAY_TYPE_LINE = `  day_type: today (النهارده), tomorrow (بكرة), day_after_tomorrow (بعد بكرة), weekday (a named day: set "weekday"), date (a calendar date: set "day_of_month", "month" if stated, and "year" only if they said a year), or none.`

/** How to report an appointment as components: shared by every prompt that reads one */
export const APPOINTMENT_COMPONENTS = `- When the visitor's latest message asks for, agrees to or changes an appointment and names a specific day, a specific time, or both, fill "appointment" with what THEY said, as components. Report, don't calculate: no dates worked out from "tomorrow" or a weekday, no 24-hour conversion, and no guessing a part of the day they didn't say.
${DAY_TYPE_LINE}
  hour and minute exactly as said ("الساعة 6" → 6; "11 ونص" → 11 and 30). period: morning (الصبح), noon (الضهر), afternoon (العصر), evening (المغرب), night (بالليل / العشا), or unspecified when they didn't say.
- A new time without a day ("خليها 7") is day_type none with the new hour, and a new day without a time is the day with no hour: the system keeps what they already chose of the rest, also after a refusal: a time refused on a day keeps the day, and a day the business is closed keeps the time. Always the visitor's latest choice.
- needs_team_check: true when the information you were given says the business is closed or unavailable at that time (a holiday, a doctor who is away), or you cannot tell whether it can be honoured. Report the request all the same: the system decides what becomes of it.`

/** Where the reply states what is on record; replaced from the lead row */
export const SAVED_PHONE_PLACEHOLDER = '{{saved_phone}}'
export const SAVED_NAME_PLACEHOLDER = '{{saved_name}}'

const JSON_ANSWER = `Answer as JSON with "contact", "appointment", "other_answer" and "reply" (your message to the visitor).`

// The visitor's name and number: reported in every booking mode, and with none
const CONTACT_REPORTING = `The visitor's details ("contact", null when the latest message gives none):
- name: the name the visitor gave for themselves in their LATEST message, copied exactly as they wrote it. phone: the phone number they gave in their LATEST message, every digit as written, even if it looks wrong or incomplete. Report, don't judge and don't correct: the system checks them and tells the visitor itself when one is not usable. Report them whenever the visitor gives them, also before they were asked for and before the appointment is complete: the system keeps them, and does not ask for them again.
- You cannot see what has been saved, but the system can. Never say that a name or a number was received, saved, recorded, registered or updated, and never write the visitor's phone number in "reply". When the visitor asks what is on record ("سجلت رقمي؟"), or you want to state it, answer with the placeholder — ${SAVED_PHONE_PLACEHOLDER} for the phone number, ${SAVED_NAME_PLACEHOLDER} for the name, as in "رقمك المسجّل عندنا ${SAVED_PHONE_PLACEHOLDER}" — and never by saying that you can't see it: the system replaces the placeholder with what is actually stored, or says that nothing is.`

const APPOINTMENT_REPORTING = `Appointments ("appointment"):
${APPOINTMENT_COMPONENTS}
- Report only what the latest message itself says, also when it only completes what the visitor asked before (which part of the day, or which hour): the system holds what earlier messages gave and puts the two together. Don't repeat the day or the hour of an earlier message.
- Whenever "appointment" is not null, the SYSTEM writes everything the visitor is told about it: whether it is recorded, confirmed, refused, outside working hours, or still needs their name or number. Your "reply" is NOT shown to the visitor on that turn, so nothing you think about the time — that it is fine, that it is not possible, that another time would be better — reaches them or should be written anywhere else.
- "other_answer": when the same message ALSO asked about something that is not the appointment (a price, insurance, an address, a doctor), answer that here, and only that. Nothing about the appointment, its day or time, opening hours as a reason, or whether it can be booked. Null when the message asked nothing else, and null whenever "appointment" is null, unless you are told below that a time the visitor asked for earlier is held.
- When "appointment" is null and you mention an appointment the visitor already has, write ${APPOINTMENT_PLACEHOLDER} in "reply" exactly where its day and time belong, and never write the day or the time yourself: the system replaces it with the appointment on record. Never say that something is booked or confirmed yourself.
- With neither a specific day nor a time ("next week", "soon", "any time"), "appointment" is null: don't use ${APPOINTMENT_PLACEHOLDER}, and ask for the day and time. A specific day without a time ("الخميس"), or a time without a day, is reported: the system keeps it and asks for the rest.
- "appointment" is null whenever the latest message isn't about scheduling.`

/** The instructions that go with BOT_REPLY_SCHEMA in the system prompt, for a business that books a day and a time */
export const APPOINTMENT_INSTRUCTIONS = [JSON_ANSWER, CONTACT_REPORTING, APPOINTMENT_REPORTING].join('\n\n')

/**
 * For a business that books a day, first come first served. The model may
 * still report an hour; code drops it (withoutTime) and no time is ever asked
 * for or confirmed by code, so these lines are a request and the code is the
 * guarantee. The booking section is the copy owner's Arabic (prompts-ar.ts);
 * the two shared paragraphs above it stay English, as in appointments.
 */
export const DAY_ONLY_INSTRUCTIONS = [JSON_ANSWER, CONTACT_REPORTING, DAY_ONLY_BOOKING_AR].join('\n\n')

/**
 * For a business that does not book through the chat: the team follows up on
 * every lead. The one mode where the model itself asks for the name and the
 * number, as the code works (prompts-ar.ts).
 */
export const NO_BOOKING_INSTRUCTIONS = [JSON_ANSWER, CONTACT_REPORTING, NO_BOOKING_AR].join('\n\n')

/**
 * The day-only booking order: the day is the model's step, the name and the
 * number are the system's, listed so the model knows where the conversation
 * stands. It replaces BOOKING_ORDER_INSTRUCTIONS, whose second step is the
 * hour; its last line is that order's own, byte for byte (prompts-ar.ts).
 */
export const DAY_ONLY_ORDER_INSTRUCTIONS = DAY_ONLY_ORDER_AR

/** Removes the hour from what was reported: a day-only business never takes one */
export function withoutTime<T extends Pick<AppointmentRequest, 'hour' | 'minute' | 'period'>>(request: T): T {
  return { ...request, hour: null, minute: null, period: 'unspecified' }
}

/**
 * Added to the prompt while a time the visitor asked for earlier is held on
 * the lead for their name or number (confirmPending): on this message the
 * system books it, refuses it or asks for the next detail without the model
 * reporting anything, and the reply is not sent, so the rest of the answer
 * has to be in "other_answer" already.
 */
export const HELD_REQUEST_INSTRUCTIONS = `A day and time the visitor asked for earlier is held until their name and phone number are both on record. On this message the system books it, refuses it, or asks for the name or number still missing, and your "reply" is NOT shown to the visitor: the system says what became of it. So whenever "appointment" is null, also write in "other_answer" your answer to everything in the latest message that is not about that appointment (a greeting, a question), with nothing about the appointment, its day or time, whether it can be booked, or the name or number still needed: the system asks for those itself. Null when there is nothing else to say. "reply" is written as usual.`

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

type Incomplete = {
  status: 'incomplete'
  missing: ('day' | 'time')[]
  day: string | null
  time: Pick<AppointmentRequest, 'hour' | 'minute' | 'period'> | null
}

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
  /**
   * Part of a booking: the day or the time is still to come. `day`: the
   * calendar day ("2026-10-22") when it is the time that is missing; `time`:
   * the hour held when it is the day. The question names what is held.
   */
  | Incomplete
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
 * gap: without a day or a time there is no appointment yet ('incomplete',
 * which says which one is missing), and an hour
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
    hourFromPartOfDay = true,
  }: {
    now?: Date
    keepDayOf?: string | null
    businessHours?: BusinessHours | null
    /**
     * A part of the day alone ("Thursday morning") gets a usual hour for it,
     * flagged approximate. False where the visitor can be asked instead (the
     * reply): "بكرة بالليل" is then kept and the hour asked for, not booked
     * at 9 PM (frozen eval, AM03, 18 October 2026).
     */
    hourFromPartOfDay?: boolean
  } = {}
): AppointmentResolution {
  const today: CalendarDay = cairoParts(now)
  const found = requestedDay(request, today, keepDayOf)
  if (found !== null && 'status' in found) return found
  const day = found
  const hasTime = request.hour !== null || request.period !== 'unspecified'
  if (!day) {
    const time = request.hour !== null ? { hour: request.hour, minute: request.minute, period: request.period } : null
    return { status: 'incomplete', missing: hasTime ? ['day'] : ['day', 'time'], day: null, time }
  }

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
  } else if (request.period !== 'unspecified' && hourFromPartOfDay) {
    hour = PERIOD_DEFAULT_HOUR[request.period]
    approximate = true
  } else {
    // A day and no time: refused now if the business is closed that day,
    // otherwise kept while the time is asked for
    if (Date.UTC(day.year, day.month, day.day) > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) return NONE
    const weekday = weekdayOf(day)
    if (businessHours?.enabled && !businessHours.days[HOURS_DAY[weekday]].open) {
      return { status: 'outside_hours', hours: { weekday, open: false } }
    }
    return { status: 'incomplete', missing: ['time'], day: dateKey(day), time: null }
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

const dateKey = (day: CalendarDay) => `${day.year}-${pad(day.month + 1)}-${pad(day.day)}`

// Where a day-only visit is placed in time when the business has set no
// hours: midday, so it sorts and shows on the right date in any time zone
const DAY_ONLY_ANCHOR = '12:00'

/**
 * A day, for a business that books days (first come, first served). No hour
 * is read from the request: whatever the model reported, only the day counts.
 * The visit is stored at that day's opening time (midday without hours), and
 * marked day-only on the lead, so nothing shows or states that time as an
 * appointment time.
 *
 * Today counts until closing time; a weekday named on that day after closing
 * is next week's. A day the business is closed is refused like a closed day
 * in an appointment.
 */
export function resolveDay(
  request: AppointmentRequest,
  { now = new Date(), businessHours = null }: { now?: Date; businessHours?: BusinessHours | null } = {}
): AppointmentResolution {
  const today: CalendarDay = cairoParts(now)
  const found = requestedDay(withoutTime(request), today, null)
  if (found !== null && 'status' in found) return found
  if (!found) return { status: 'incomplete', missing: ['day'], day: null, time: null }
  let day = found

  const closingPassed = (d: CalendarDay) => {
    if (!businessHours?.enabled || dateKey(d) !== dateKey(today)) return false
    const schedule = businessHours.days[HOURS_DAY[weekdayOf(d)]]
    // A day that closes after midnight is still open tonight
    return schedule.open && schedule.to > schedule.from && cairoParts(now).time >= schedule.to
  }
  if (closingPassed(day)) {
    if (request.day_type !== 'weekday') return PAST
    day = addDays(day, 7)
  }
  if (Date.UTC(day.year, day.month, day.day) > now.getTime() + MAX_DAYS_AHEAD * DAY_MS) return NONE

  const weekday = weekdayOf(day)
  const schedule = businessHours?.enabled ? businessHours.days[HOURS_DAY[weekday]] : null
  if (schedule && !schedule.open) return { status: 'outside_hours', hours: { weekday, open: false } }
  const at = new Date(cairoWallTimeToIso(day.year, day.month, day.day, schedule?.from ?? DAY_ONLY_ANCHOR))
  return { status: 'resolved', at: at.toISOString(), approximate: false, validated: businessHours?.enabled === true }
}

/**
 * The calendar day a request names, before any time is looked at: a day,
 * null when it names none, or the refusal a date earns on its own (one that
 * doesn't exist, or one with its year that has gone). `keepDayOf`: the
 * appointment on record, whose day a time-only change keeps.
 */
function requestedDay(request: AppointmentRequest, today: CalendarDay, keepDayOf: string | null): CalendarDay | null | AppointmentResolution {
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
  return day
}

type DayPart = Pick<AppointmentRequest, 'day_type' | 'weekday' | 'day_of_month' | 'month' | 'year'>
type TimePart = Pick<AppointmentRequest, 'hour' | 'minute' | 'period'>

/**
 * What the visitor has said so far toward one appointment that is not one
 * yet: kept with each reply (the message's metadata) and read back on the
 * next message, so that code, not the model, remembers it.
 *
 * Seen on the demo widget, 18 October 2026 (conversation 0c6b8d64): Thursday
 * at 11 in the morning and at 11 at night were both refused, then "7 بالليل"
 * came in. The model reported it without the day, as it is told it may
 * ("خليها 7"), but code only kept a day that had become an appointment or a
 * held request, and a refused time is neither: the visitor was asked "يوم
 * إيه" and booked one message later, after complaining.
 *
 * A refusal narrows the draft rather than emptying it: a time refused on
 * Thursday takes back the time, not Thursday; a day the business is closed
 * takes back the day, not the time. Once the time becomes an appointment or
 * a held request the lead holds it, and the draft ends.
 */
export type BookingDraft = {
  day: DayPart | null
  time: TimePart | null
  /** The branch the visitor chose: kept like the day and the time, filled once the model reports one (the branches step) */
  branch: string | null
}

const bookingDraftSchema = z.object({
  day: appointmentRequestSchema
    .pick({ day_type: true, weekday: true, day_of_month: true, month: true, year: true })
    .nullable()
    .catch(null),
  time: appointmentRequestSchema.pick({ hour: true, minute: true, period: true }).nullable().catch(null),
  branch: z.string().nullable().catch(null),
})

/** The draft a reply left, from its metadata; null when there is none or it is not one */
export function parseBookingDraft(value: unknown): BookingDraft | null {
  const parsed = bookingDraftSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

/**
 * What the latest message reported, completed from the draft: a part it
 * gives replaces the draft's, a part it leaves out is the draft's. A part of
 * the day alone ("الصبح") answers "morning or evening?" about the hour in the
 * draft; otherwise it is a new time.
 */
export function mergeDraft(draft: BookingDraft | null, request: AppointmentRequest): AppointmentRequest {
  if (!draft) return request
  const day: DayPart = request.day_type !== 'none' ? request : (draft.day ?? request)
  const held = draft.time
  const time: TimePart =
    request.hour !== null
      ? // "الساعة 9" after "بالليل": the part of the day already given
        request.period === 'unspecified' && held && held.hour === null && held.period !== 'unspecified'
        ? { ...request, period: held.period }
        : request
      : request.period !== 'unspecified'
        ? held && held.hour !== null && held.period === 'unspecified'
          ? { ...held, period: request.period }
          : request
        : (held ?? request)
  return {
    ...request,
    day_type: day.day_type,
    weekday: day.weekday,
    day_of_month: day.day_of_month,
    month: day.month,
    year: day.year,
    hour: time.hour,
    minute: time.minute,
    period: time.period,
  }
}

/** No day, no hour, no part of the day: nothing about the booking at all */
export const saysNothing = (request: AppointmentRequest) =>
  request.day_type === 'none' && request.hour === null && request.period === 'unspecified'

/** What the visitor is asked when nothing of a booking is known yet */
export const ASK_DAY_AND_TIME: BookingOutcome = { status: 'incomplete', missing: ['day', 'time'], day: null, time: null }

/** A message that said nothing about the booking: merged with a draft, it is the draft */
export const NOTHING_SAID: AppointmentRequest = {
  day_type: 'none',
  weekday: null,
  day_of_month: null,
  month: null,
  year: null,
  hour: null,
  minute: null,
  period: 'unspecified',
  needs_team_check: null,
}

/**
 * Whether a partial booking already holds everything the business books (a
 * day and a time; a day for a day-only business) and would be accepted now.
 * Only a booking write that failed leaves one behind: every other outcome
 * either books it or narrows it.
 */
export function resolvesWhole(
  draft: BookingDraft,
  mode: Exclude<BookingMode, 'none'>,
  businessHours: BusinessHours | null,
  now = new Date()
): boolean {
  const request = mergeDraft(draft, NOTHING_SAID)
  const resolved =
    mode === 'day_only' ? resolveDay(request, { now, businessHours }) : resolveAppointment(request, { now, businessHours, hourFromPartOfDay: false })
  return resolved.status === 'resolved'
}

const RELATIVE_DAYS: Partial<Record<DayPart['day_type'], number>> = { today: 0, tomorrow: 1, day_after_tomorrow: 2 }

/** "بكرة" said today is a date: it must not move if the next message comes after midnight */
function fixedDay(request: DayPart, now: Date): DayPart {
  const offset = RELATIVE_DAYS[request.day_type]
  const { day_type, weekday, day_of_month, month, year } = request
  if (offset === undefined) return { day_type, weekday, day_of_month, month, year }
  const d = addDays(cairoParts(now), offset)
  return { day_type: 'date', weekday: null, day_of_month: d.day, month: d.month + 1, year: d.year }
}

/** A date with its year that is before today: refused as a day, whatever the time */
function dayHasGone(day: DayPart, now: Date) {
  if (day.day_type !== 'date' || !day.day_of_month || !day.year) return false
  const today = cairoParts(now)
  return Date.UTC(day.year, (day.month ?? today.month + 1) - 1, day.day_of_month) < Date.UTC(today.year, today.month, today.day)
}

/**
 * The draft after this message: what `request` (already merged) held, less
 * the part the outcome refused. Null once the lead holds the time, or when
 * nothing is left.
 */
export function narrowDraft(
  previous: BookingDraft | null,
  request: AppointmentRequest,
  outcome: BookingOutcome,
  now = new Date()
): BookingDraft | null {
  const day = request.day_type === 'none' ? null : fixedDay(request, now)
  const time = request.hour === null && request.period === 'unspecified' ? null : { hour: request.hour, minute: request.minute, period: request.period }
  const branch = previous?.branch ?? null
  const keep = (d: DayPart | null, t: TimePart | null) => (d || t || branch ? { day: d, time: t, branch } : null)
  switch (outcome.status) {
    case 'booked':
    case 'kept':
    case 'needs_details':
      return null
    case 'outside_hours':
      return outcome.hours.open ? keep(day, null) : keep(null, time)
    case 'past':
      // A date that has gone takes back the day and keeps the time; a time
      // gone today takes back the time and keeps the day
      return day && dayHasGone(day, now) ? keep(null, time) : keep(day, null)
    case 'none':
      // Unusable is a day that doesn't exist or is too far ahead
      return keep(null, time)
    case 'ask_period':
    case 'incomplete':
      return keep(day, time)
  }
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

/** The day of a stored instant, in Cairo, without its time: how a day-only visit is stated */
export function formatVisitDay(at: string, language: ReplyLanguage) {
  return formatDay(dateKey(cairoParts(at)), language)
}

/** "الخميس 22 أكتوبر" / "Thursday 22 October" from a calendar day ("2026-10-22") */
function formatDay(dateKey: string, language: ReplyLanguage) {
  const [year, month, day] = dateKey.split('-').map(Number)
  const date = new Date(Date.UTC(year, month - 1, day, 12))
  const part = (options: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat(LOCALES[language], { timeZone: 'UTC', ...options }).format(date)
  return `${part({ weekday: 'long' })} ${part({ day: 'numeric' })} ${part({ month: 'long' })}`
}

/**
 * A time held without its day, as the visitor said it: "5:00 مساءً" once the
 * part of the day settles it, the bare "5" while it doesn't
 */
function formatHeldTime({ hour, minute, period }: Pick<AppointmentRequest, 'hour' | 'minute' | 'period'>, language: ReplyLanguage) {
  if (hour === null) return ''
  if (period === 'unspecified' && hour >= 1 && hour <= 12) return minute ? `${hour}:${pad(minute)}` : String(hour)
  return formatClock(`${pad(to24Hour(hour, period) % 24)}:${pad(minute ?? 0)}`, language)
}

/** What happened to the appointment the visitor asked for */
export type BookingOutcome =
  /**
   * On record at `at`. `changed`: this message set or moved it. `validated`:
   * code checked it against opening hours (or a person set or confirmed it);
   * absent means nobody did, and a day-only visit is then stated as a request
   */
  | { status: 'booked'; at: string; confirmed: boolean; changed: boolean; validated?: boolean }
  /** The team's own time stays; the request was not applied */
  | { status: 'kept'; at: string; validated?: boolean }
  /** Nothing recorded yet: morning or evening has to be asked */
  | { status: 'ask_period'; hour: number }
  /**
   * Not an appointment yet: the time is kept as a request until the visitor's
   * name and phone number are both on record. `handoff`: the bot has stopped
   * asking for the phone number, a person completes it.
   */
  | { status: 'needs_details'; at: string; missing: ('name' | 'phone')[]; handoff: boolean; validated?: boolean }
  /** Nothing recorded: the business is closed then */
  | { status: 'outside_hours'; hours: OpeningDay }
  /** Nothing recorded: that day and time have gone */
  | { status: 'past' }
  /** Nothing recorded yet: the day or the time is still to come (kept in the draft meanwhile) */
  | Incomplete
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

/**
 * What the system's sentences follow: the business's booking shape, and how
 * much of a name it asks for. Without it, an appointment business that asks
 * for a full name (the behaviour before these settings existed).
 */
export type ReplyRules = { mode: BookingMode; nameStrictness: NameStrictness }
export const DEFAULT_REPLY_RULES: ReplyRules = { mode: 'appointment', nameStrictness: 'two_parts' }

/** The appointment on record, in the system's own words: confirmed, or a request the team confirms */
function bookedLine(outcome: Extract<BookingOutcome, { status: 'booked' }>, language: ReplyLanguage, rules: ReplyRules) {
  const t = TEXTS[language]
  // A day-only visit: the day, arrival order, and that someone will call. Never a time.
  // «حجزك» only for a day code checked against opening hours: without them it
  // is a request, as an appointment business says (the closed Fridays booked
  // for Dr.Ali on 22 October 2026, a client with no hours entered)
  if (rules.mode === 'day_only') {
    return (outcome.validated ? t.bookedDay : t.bookedDayRequest).replace('{day}', formatVisitDay(outcome.at, language))
  }
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
export function appointmentLine(outcome: BookingOutcome, language: ReplyLanguage, rules: ReplyRules = DEFAULT_REPLY_RULES): string {
  const t = TEXTS[language]
  const dayOnly = rules.mode === 'day_only'
  switch (outcome.status) {
    case 'booked':
      return bookedLine(outcome, language, rules)
    case 'kept':
      return dayOnly
        ? (outcome.validated ? t.keptDay : t.keptDayRequest).replace('{day}', formatVisitDay(outcome.at, language))
        : t.kept.replace('{time}', formatAppointment(outcome.at, language))
    case 'ask_period':
      return t.askPeriod.replace('{hour}', String(outcome.hour))
    case 'outside_hours':
      return describeOpening(outcome.hours, language)
    case 'past':
      return dayOnly ? t.pastDay : t.past
    case 'incomplete':
      // A day-only business is only ever asked for the day
      if (dayOnly) return t.askTime
      // Only what is still missing is asked for, and what is held is named in the
      // question: a visitor who answers "الثلاثاء" sees the 5 o'clock it goes with
      if (!outcome.missing.includes('day') && outcome.day) return t.askHour.replace('{day}', formatDay(outcome.day, language))
      if (outcome.missing.includes('time')) return t.askTime
      return outcome.time ? t.askDayAt.replace('{time}', formatHeldTime(outcome.time, language)) : t.askDay
    case 'needs_details': {
      // One thing per message, the name before the number (the booking
      // order): the next one is asked for once this one is on record
      const name = rules.nameStrictness === 'single' ? t.missingNameAny : t.missingName
      const missing = outcome.missing[0] === 'name' ? name : t.missingPhone
      if (dayOnly) {
        const day = formatVisitDay(outcome.at, language)
        if (outcome.handoff) return t.needDetailsDayHandoff.replace('{day}', day)
        // "To book Friday…" promises the day before anything checked it
        return (outcome.validated ? t.needDetailsDay : t.needDetailsDayRequest).replace('{day}', day).replace('{missing}', missing)
      }
      const time = formatAppointment(outcome.at, language)
      return outcome.handoff ? t.needDetailsHandoff.replace('{time}', time) : t.needDetails.replace('{time}', time).replace('{missing}', missing)
    }
    case 'none':
      // No usable day and time in what was reported
      return t.askTime
  }
}

/**
 * The reply as the visitor gets it. The model's text never states the time:
 * the placeholder is filled with the appointment that is actually on record,
 * and whether it is confirmed is said here, from the record, not by the model.
 */
export function renderReply(template: string, outcome: BookingOutcome, language: ReplyLanguage, rules: ReplyRules = DEFAULT_REPLY_RULES): string {
  const t = TEXTS[language]
  const hasPlaceholder = template.includes(APPOINTMENT_PLACEHOLDER)

  if (outcome.status === 'kept') return appointmentLine(outcome, language, rules)
  // Whatever the model wrote, nothing is booked until this is answered
  if (outcome.status === 'ask_period') return t.askPeriod.replace('{hour}', String(outcome.hour))
  if (outcome.status === 'none') {
    if (!hasPlaceholder) return template
    // Nothing was booked: keep what else the model said, and ask for the day
    // and time instead of the booking it claimed. A business that doesn't
    // book through the chat is never asked about one.
    const rest = withoutAppointmentSentences(template)
    if (rules.mode === 'none') return rest
    return rest ? `${rest}\n${t.askTime}` : t.askTime
  }
  // Refused, or not an appointment yet: what the model wrote about the
  // booking goes, the rest of its answer stays, and code says why
  if (
    outcome.status === 'outside_hours' ||
    outcome.status === 'past' ||
    outcome.status === 'needs_details' ||
    outcome.status === 'incomplete'
  ) {
    const rest = withoutAppointmentSentences(template)
    const said = appointmentLine(outcome, language, rules)
    return rest ? `${rest}\n${said}` : said
  }

  if (!outcome.changed && !hasPlaceholder) return template
  if (rules.mode === 'day_only') {
    // The model never states the visit, set on this message or restated: its
    // sentences around the placeholder go («حجزك يوم الجمعة» on a day nobody
    // checked), and the system's own sentence says booking or request
    return [withoutAppointmentSentences(template), bookedLine(outcome, language, rules)].filter(Boolean).join('\n')
  }
  const time = formatAppointment(outcome.at, language)
  const status = outcome.confirmed ? t.confirmed : t.pending
  // A time asked for earlier became the appointment on this message, which
  // was about something else: the model's answer, then the system's sentence
  if (!hasPlaceholder) return [template, bookedLine(outcome, language, rules)].filter(Boolean).join('\n')

  // Whether it is confirmed goes right after the sentence that states the
  // appointment, before anything the reply goes on to ask: "…6:00 مساءً.
  // موعدك مؤكَّد ✅ ممكن رقم موبايلك؟" reads as settled, then the question
  const sentences = template.split(SENTENCE_END)
  const last = sentences.findLastIndex((sentence) => sentence.includes(APPOINTMENT_PLACEHOLDER))
  const fill = (part: string[]) => part.join('').replaceAll(APPOINTMENT_PLACEHOLDER, time).trim()
  const rest = fill(sentences.slice(last + 1))
  return [fill(sentences.slice(0, last + 1)), status, rest].filter(Boolean).join('\n')
}
