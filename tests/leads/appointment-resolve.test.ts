import { describe, expect, it } from 'vitest'
import ar from '../../messages/ar.json'
import {
  appointmentLine,
  appointmentRequestSchema,
  formatAppointment,
  mergeDraft,
  narrowDraft,
  parseBookingDraft,
  renderReply,
  resolveAppointment,
} from '@/lib/ai/appointment'
import type { BusinessHours } from '@/lib/types/bot-settings'

// Monday 5 October 2026, 12:00 in Cairo (UTC+3)
const now = new Date('2026-10-05T09:00:00.000Z')
type Hours = Parameters<typeof resolveAppointment>[1] extends infer O ? NonNullable<O> extends { businessHours?: infer H } ? H : never : never

const resolve = (request: Record<string, unknown>, keepDayOf: string | null = null, businessHours: Hours = null) =>
  resolveAppointment(appointmentRequestSchema.parse({ period: 'unspecified', ...request }), { now, keepDayOf, businessHours })

/** Open every day but Friday, `from`–`to` */
const hours = (from: string, to: string): BusinessHours => ({
  enabled: true,
  timezone: 'Africa/Cairo',
  days: Object.fromEntries(
    ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'].map((day) => [day, { open: day !== 'fri', from, to }])
  ) as BusinessHours['days'],
})
// Every day but Friday, Saturday first (Date#getDay() numbers)
const ALL_BUT_FRIDAY = [6, 0, 1, 2, 3, 4]

// `validated`: the time was checked against opening hours (there were some)
const at = (iso: string, approximate = false, validated = false) => ({ status: 'resolved', at: iso, approximate, validated })
const NONE = { status: 'none' }

describe('resolveAppointment: components → one Cairo instant', () => {
  it.each([
    ['tomorrow, 5 in the afternoon', { day_type: 'tomorrow', hour: 5, period: 'afternoon' }, '2026-10-06T14:00:00.000Z'],
    ['tomorrow, 10 in the morning', { day_type: 'tomorrow', hour: 10, period: 'morning' }, '2026-10-06T07:00:00.000Z'],
    ['tomorrow at 9 at night', { day_type: 'tomorrow', hour: 9, period: 'night' }, '2026-10-06T18:00:00.000Z'],
    ['today at 11:30 at night', { day_type: 'today', hour: 11, minute: 30, period: 'night' }, '2026-10-05T20:30:00.000Z'],
    ['1 at noon', { day_type: 'tomorrow', hour: 1, period: 'noon' }, '2026-10-06T10:00:00.000Z'],
    ['the day after tomorrow, 4 in the afternoon', { day_type: 'day_after_tomorrow', hour: 4, period: 'afternoon' }, '2026-10-07T13:00:00.000Z'],
    ['Thursday, 6 in the evening', { day_type: 'weekday', weekday: 'thursday', hour: 6, period: 'evening' }, '2026-10-08T15:00:00.000Z'],
    ['Monday at 15: today, still ahead', { day_type: 'weekday', weekday: 'monday', hour: 15 }, '2026-10-05T12:00:00.000Z'],
    ['Monday at 9 in the morning: already gone, so next Monday', { day_type: 'weekday', weekday: 'monday', hour: 9, period: 'morning' }, '2026-10-12T06:00:00.000Z'],
    ['the 20th, no month', { day_type: 'date', day_of_month: 20, hour: 17 }, '2026-10-20T14:00:00.000Z'],
    ['the 2nd, no month: next month', { day_type: 'date', day_of_month: 2, hour: 17 }, '2026-11-02T15:00:00.000Z'],
    ['midnight tomorrow night runs into the next day', { day_type: 'tomorrow', hour: 12, period: 'night' }, '2026-10-06T21:00:00.000Z'],
  ])('%s', (_name, request, expected) => {
    expect(resolve(request)).toEqual(at(expected))
  })

  it('uses a usual hour for a part of the day, flagged as approximate', () => {
    expect(resolve({ day_type: 'weekday', weekday: 'thursday', period: 'morning' })).toEqual(
      at('2026-10-08T07:00:00.000Z', true)
    )
  })

  it('keeps the recorded day for a time-only change', () => {
    expect(resolve({ day_type: 'none', hour: 7, period: 'night' }, '2026-10-08T15:00:00.000Z')).toEqual(
      at('2026-10-08T16:00:00.000Z')
    )
  })

  describe('an hour with no part of the day ("الساعة 9")', () => {
    const nine = { day_type: 'tomorrow', hour: 9 }
    const ASK = { status: 'ask_period', hour: 9 }

    it('is the evening for a business open 4 PM to 10 PM', () => {
      expect(resolve(nine, null, hours('16:00', '22:00'))).toEqual(at('2026-10-06T18:00:00.000Z', false, true))
    })

    it('is the morning for a business open 8 AM to 4 PM', () => {
      expect(resolve(nine, null, hours('08:00', '16:00'))).toEqual(at('2026-10-06T06:00:00.000Z', false, true))
    })

    it('follows opening hours that run past midnight, but asks about the small hours', () => {
      const lateNight = hours('18:00', '02:00')
      expect(resolve(nine, null, lateNight)).toEqual(at('2026-10-06T18:00:00.000Z', false, true))
      // 1 AM at the start of tomorrow, or after tomorrow's evening?
      expect(resolve({ day_type: 'tomorrow', hour: 1 }, null, lateNight)).toEqual({ status: 'ask_period', hour: 1 })
    })

    it.each([
      ['no business hours on record', null],
      ['business hours switched off', { ...hours('16:00', '22:00')!, enabled: false }],
      ['both readings inside the opening hours', hours('08:00', '22:00')],
      ['neither reading inside them', hours('10:00', '18:00')],
    ])('is asked about, not guessed: %s', (_name, businessHours) => {
      expect(resolve(nine, null, businessHours)).toEqual(ASK)
    })

    it('is asked about on a day the business is closed', () => {
      // Friday 9 October
      expect(resolve({ day_type: 'weekday', weekday: 'friday', hour: 9 }, null, hours('16:00', '22:00'))).toEqual(ASK)
    })

    it('needs no asking when the hour reads one way only', () => {
      expect(resolve({ day_type: 'tomorrow', hour: 21 })).toEqual(at('2026-10-06T18:00:00.000Z'))
      expect(resolve({ ...nine, period: 'night' })).toEqual(at('2026-10-06T18:00:00.000Z'))
    })
  })

  it.each([
    // Whether an hour like this one was said at all is withEvidence's to decide, before this
    ['no day and nothing on record', { day_type: 'none', hour: 17 }, { status: 'incomplete', missing: ['day'], day: null, time: { hour: 17, minute: null, period: 'unspecified' } }],
    ['a day with no time at all', { day_type: 'tomorrow' }, { status: 'incomplete', missing: ['time'], day: '2026-10-06', time: null }],
    ['a weekday type without the weekday', { day_type: 'weekday', hour: 17 }, { status: 'incomplete', missing: ['day'], day: null, time: { hour: 17, minute: null, period: 'unspecified' } }],
    ['neither a day nor a time', { day_type: 'none' }, { status: 'incomplete', missing: ['day', 'time'], day: null, time: null }],
    // An hour of 40 is no hour (the schema drops it); whether the day was said is withEvidence's to decide
    ['an hour out of range', { day_type: 'tomorrow', hour: 40 }, { status: 'incomplete', missing: ['time'], day: '2026-10-06', time: null }],
  ])('says what is still missing rather than guess: %s', (_name, request, expected) => {
    expect(resolve(request)).toEqual(expected)
  })

  it('refuses a day the business is closed even before the time is given', () => {
    // Friday 9 October
    expect(resolve({ day_type: 'weekday', weekday: 'friday' }, null, hours('12:00', '22:00'))).toEqual({
      status: 'outside_hours',
      hours: { weekday: 5, open: false },
      openDays: ALL_BUT_FRIDAY,
    })
  })

  it.each([
    ['a date that does not exist', { day_type: 'date', day_of_month: 31, month: 11, hour: 17 }],
    ['more than six months ahead', { day_type: 'date', day_of_month: 1, month: 9, hour: 17 }],
  ])('returns nothing rather than guess: %s', (_name, request) => {
    expect(resolve(request)).toEqual(NONE)
  })

  it('says a time already gone today is past, rather than guess another day', () => {
    expect(resolve({ day_type: 'today', hour: 9, period: 'morning' })).toEqual({ status: 'past' })
  })

  describe('a date with the year the visitor stated', () => {
    it('is taken as said', () => {
      expect(resolve({ day_type: 'date', day_of_month: 25, month: 1, year: 2027, hour: 5, period: 'afternoon' })).toEqual(
        at('2027-01-25T15:00:00.000Z')
      )
    })

    // Seen on the demo widget (12 October 2026): "25 يناير 2026" was booked for 25 January 2027
    it('is refused when it has gone, never moved to next year', () => {
      expect(resolve({ day_type: 'date', day_of_month: 25, month: 1, year: 2026, hour: 5, period: 'afternoon' })).toEqual({
        status: 'past',
      })
      // Without a year the same words mean the next 25 January
      expect(resolve({ day_type: 'date', day_of_month: 25, month: 1, hour: 5, period: 'afternoon' })).toEqual(
        at('2027-01-25T15:00:00.000Z')
      )
    })
  })

  describe('a time the business is closed at', () => {
    // The demo clinic's main branch: noon to 10 PM
    const clinic = hours('12:00', '22:00')

    // Seen on the demo widget (12 October 2026): "بكرة الساعة 5 الفجر" was booked and confirmed
    it('is refused with that day\'s hours: 5 in the morning at a clinic that opens at noon', () => {
      expect(resolve({ day_type: 'tomorrow', hour: 5, period: 'morning' }, null, clinic)).toEqual({
        status: 'outside_hours',
        hours: { weekday: 2, open: true, ranges: [['12:00', '22:00']] },
        openDays: ALL_BUT_FRIDAY,
      })
    })

    it('is refused at closing time and after it, accepted up to it', () => {
      expect(resolve({ day_type: 'tomorrow', hour: 22 }, null, clinic)).toMatchObject({ status: 'outside_hours' })
      expect(resolve({ day_type: 'tomorrow', hour: 21, minute: 30 }, null, clinic)).toEqual(at('2026-10-06T18:30:00.000Z', false, true))
    })

    it('is refused on a day the business is closed', () => {
      // Friday 9 October
      expect(resolve({ day_type: 'weekday', weekday: 'friday', hour: 6, period: 'evening' }, null, clinic)).toEqual({
        status: 'outside_hours',
        hours: { weekday: 5, open: false },
        openDays: ALL_BUT_FRIDAY,
      })
    })

    it('is not judged at all without opening hours: accepted, and not validated', () => {
      expect(resolve({ day_type: 'tomorrow', hour: 5, period: 'morning' })).toEqual(at('2026-10-06T02:00:00.000Z'))
    })
  })

  it('follows the Cairo offset across the end of summer time', () => {
    // Clocks go back on the last Friday of October: 18:00 is 16:00 UTC afterwards
    expect(resolve({ day_type: 'date', day_of_month: 5, month: 11, hour: 6, period: 'evening' })).toEqual(
      at('2026-11-05T16:00:00.000Z')
    )
  })

  it('formats the stored instant in Cairo time', () => {
    expect(formatAppointment('2026-10-08T15:00:00.000Z', 'ar')).toBe('الخميس 8 أكتوبر الساعة 6:00 مساءً')
    expect(formatAppointment('2026-10-08T15:00:00.000Z', 'en')).toBe('Thursday 8 October at 6:00 PM')
    expect(formatAppointment('2026-10-10T08:00:00.000Z', 'ar')).toBe('السبت 10 أكتوبر الساعة 11:00 صباحاً')
  })
})

describe('the partial booking kept between messages (the draft)', () => {
  const request = (fields: Record<string, unknown>) => appointmentRequestSchema.parse({ period: 'unspecified', ...fields })
  const thursday = (hour: number | null, period = 'unspecified') => request({ day_type: 'weekday', weekday: 'thursday', hour, period })
  const outside = { status: 'outside_hours', hours: { weekday: 4, open: true, ranges: [['12:00', '22:00']] }, openDays: ALL_BUT_FRIDAY } as const
  const closed = { status: 'outside_hours', hours: { weekday: 5, open: false }, openDays: ALL_BUT_FRIDAY } as const

  // Conversation 0c6b8d64, 18 October 2026: two refused times, then "7 بالليل" without the day
  it('keeps the day when the time on it is refused, and completes a day-less time with it', () => {
    let draft = narrowDraft(null, thursday(11, 'morning'), outside, now)
    expect(draft).toEqual({ day: { day_type: 'weekday', weekday: 'thursday', day_of_month: null, month: null, year: null }, time: null, branch: null })
    draft = narrowDraft(draft, mergeDraft(draft, thursday(11, 'night')), outside, now)
    const seven = mergeDraft(draft, request({ day_type: 'none', hour: 7, period: 'night' }))
    expect(resolveAppointment(seven, { now })).toEqual(at('2026-10-08T16:00:00.000Z'))
  })

  it('keeps the time and takes back the day when the day is the one that is closed', () => {
    const draft = narrowDraft(null, request({ day_type: 'weekday', weekday: 'friday', hour: 7, period: 'night' }), closed, now)
    expect(draft?.day).toBeNull()
    expect(mergeDraft(draft, request({ day_type: 'weekday', weekday: 'saturday' }))).toMatchObject({ weekday: 'saturday', hour: 7, period: 'night' })
  })

  it('answers "morning or evening?" about the hour it holds', () => {
    const draft = narrowDraft(null, thursday(11), { status: 'ask_period', hour: 11 }, now)
    expect(mergeDraft(draft, request({ day_type: 'none', period: 'morning' }))).toMatchObject({ weekday: 'thursday', hour: 11, period: 'morning' })
  })

  it('keeps the branch through a refusal, like the day', () => {
    const previous = { day: null, time: null, branch: 'التجمع' }
    expect(narrowDraft(previous, thursday(11, 'morning'), outside, now)?.branch).toBe('التجمع')
  })

  it('fixes "tomorrow" to its date, so a reply after midnight does not move it', () => {
    const draft = narrowDraft(null, request({ day_type: 'tomorrow', hour: 5, period: 'morning' }), outside, now)
    expect(draft?.day).toEqual({ day_type: 'date', weekday: null, day_of_month: 6, month: 10, year: 2026 })
  })

  it('ends once the time is an appointment or a held request', () => {
    const booked = { status: 'booked', at: '2026-10-08T16:00:00.000Z', confirmed: true, changed: true } as const
    expect(narrowDraft(null, thursday(7, 'night'), booked, now)).toBeNull()
    expect(narrowDraft(null, thursday(7, 'night'), { status: 'needs_details', at: booked.at, missing: ['phone'], handoff: false }, now)).toBeNull()
  })

  it('reads back only what it wrote', () => {
    expect(parseBookingDraft(undefined)).toBeNull()
    expect(parseBookingDraft({ day: null, time: { hour: 7, minute: null, period: 'night' }, branch: null })).toEqual({
      day: null,
      time: { hour: 7, minute: null, period: 'night' },
      branch: null,
    })
  })

  it('asks only for what is missing, naming what it already holds', () => {
    const T = ar.botReplies.appointment
    expect(appointmentLine({ status: 'incomplete', missing: ['time'], day: '2026-10-22', time: null }, 'ar')).toBe(
      T.askHour.replace('{day}', 'الخميس 22 أكتوبر')
    )
    const at5 = (period: 'afternoon' | 'unspecified') => ({ hour: 5, minute: null, period })
    expect(appointmentLine({ status: 'incomplete', missing: ['day'], day: null, time: at5('afternoon') }, 'ar')).toBe(
      T.askDayAt.replace('{time}', '5:00 مساءً')
    )
    // Morning or evening not said: the hour as said
    expect(appointmentLine({ status: 'incomplete', missing: ['day'], day: null, time: at5('unspecified') }, 'ar')).toBe(
      T.askDayAt.replace('{time}', '5')
    )
    expect(appointmentLine({ status: 'incomplete', missing: ['day'], day: null, time: null }, 'ar')).toBe(T.askDay)
    expect(appointmentLine({ status: 'incomplete', missing: ['day', 'time'], day: null, time: null }, 'ar')).toBe(T.askTime)
  })
})

describe('a reply about a time that did not become an appointment', () => {
  const T = ar.botReplies.appointment

  it('says the hours of that day, and drops what the model wrote about the booking', () => {
    const outcome = { status: 'outside_hours', hours: { weekday: 2, open: true, ranges: [['12:00', '22:00']] }, openDays: ALL_BUT_FRIDAY } as const
    expect(renderReply('تمام، هسجل طلبك {{appointment}}. محتاج حاجة تانية؟', outcome, 'ar')).toBe(
      'محتاج حاجة تانية؟\nالميعاد ده برّه مواعيد العمل: يوم الثلاثاء بنشتغل من 12:00 ظهراً لـ 10:00 مساءً. تحب ساعة تانية؟'
    )
  })

  // Dr.Ali's المنصورة, 22 October 2026: open Sunday, Monday, Wednesday and Thursday
  const MANSOURA_OPEN = [0, 1, 3, 4]
  const friday = { status: 'outside_hours', hours: { weekday: 5, open: false }, openDays: MANSOURA_OPEN } as const

  it('refuses a closed day by naming the days it opens, «و» on every one after the first', () => {
    const openDays = 'الأحد والاثنين والأربعاء والخميس'
    expect(renderReply('حجزتلك {{appointment}}.', friday, 'ar')).toBe(T.closedDay.replace('{day}', 'الجمعة').replace('{openDays}', openDays))
    expect(appointmentLine(friday, 'ar', { mode: 'day_only', nameStrictness: 'single', branch: 'فرع المنصورة' })).toBe(
      T.closedDayAt.replace('{branch}', 'فرع المنصورة').replace('{day}', 'الجمعة').replace('{openDays}', openDays)
    )
  })

  it('asks for the branch with « أو » between every name, holding the day it was given', () => {
    const branches = ['فرع المنصورة', 'فرع المنزلة', 'فرع طلخا']
    expect(appointmentLine({ status: 'ask_branch', day: null, branches: branches.slice(0, 2) }, 'ar')).toBe(
      T.askBranch.replace('{branches}', 'فرع المنصورة أو فرع المنزلة')
    )
    expect(appointmentLine({ status: 'ask_branch', day: '2026-10-23', branches }, 'ar')).toBe(
      T.askBranchForDay.replace('{day}', 'الجمعة 23 أكتوبر').replace('{branches}', 'فرع المنصورة أو فرع المنزلة أو فرع طلخا')
    )
  })

  it('names a closure by its date, and hands a branch open on no day to a person', () => {
    const rules = { mode: 'day_only', nameStrictness: 'single', branch: 'فرع المنصورة' } as const
    expect(appointmentLine({ status: 'closed_date', date: '2026-10-30' }, 'ar', rules)).toBe(
      T.closureDayAt.replace('{branch}', 'فرع المنصورة').replace('{date}', 'الجمعة 30 أكتوبر')
    )
    expect(appointmentLine({ status: 'closed_date', date: '2026-10-30' }, 'ar')).toBe(T.closureDay.replace('{date}', 'الجمعة 30 أكتوبر'))
    expect(appointmentLine({ status: 'no_open_days' }, 'ar', rules)).toBe(T.noOpenDaysAt.replace('{branch}', 'فرع المنصورة'))
    expect(appointmentLine({ status: 'no_open_days' }, 'ar')).toBe(T.noOpenDays)
  })

  it('lists a split shift\'s ranges, and names the branch when there is more than one', () => {
    const split = { status: 'outside_hours', hours: { weekday: 0, open: true, ranges: [['17:00', '21:00'], ['10:00', '13:00']] }, openDays: [0] } as const
    const ranges = `${T.timeRange.replace('{from}', '10:00 صباحاً').replace('{to}', '1:00 ظهراً')} و${T.timeRange
      .replace('{from}', '5:00 مساءً')
      .replace('{to}', '9:00 مساءً')}`
    expect(appointmentLine(split, 'ar')).toBe(T.hours.replace('{day}', 'الأحد').replace('{ranges}', ranges))
    expect(appointmentLine(split, 'ar', { mode: 'appointment', nameStrictness: 'single', branch: 'فرع المنزلة' })).toBe(
      T.hoursAt.replace('{branch}', 'فرع المنزلة').replace('{day}', 'الأحد').replace('{ranges}', ranges)
    )
  })

  it('says what is missing when the name or the number is not on record, one at a time', () => {
    const at = '2026-10-08T15:00:00.000Z'
    const time = 'الخميس 8 أكتوبر الساعة 6:00 مساءً'
    // One thing per message, the name first (the booking order): not the name and the number together
    expect(renderReply('حجزتلك {{appointment}}.', { status: 'needs_details', at, missing: ['name', 'phone'], handoff: false }, 'ar')).toBe(
      T.needDetails.replace('{time}', time).replace('{missing}', T.missingName)
    )
    expect(renderReply('حجزتلك {{appointment}}.', { status: 'needs_details', at, missing: ['phone'], handoff: true }, 'ar')).toBe(
      T.needDetailsHandoff.replace('{time}', time)
    )
  })

  it('says a time that has gone is past', () => {
    expect(renderReply('حجزتلك {{appointment}}.', { status: 'past' }, 'ar')).toBe(T.past)
  })
})

describe('where the reply says the appointment is confirmed', () => {
  const AT = '2026-10-08T15:00:00.000Z'
  const TIME = 'الخميس 8 أكتوبر الساعة 6:00 مساءً'
  const T = ar.botReplies.appointment
  const booked = (confirmed: boolean, changed = true) => ({ status: 'booked', at: AT, confirmed, changed }) as const

  it('right after the sentence that states the appointment, before the question that follows', () => {
    expect(renderReply('تمام يا أحمد، {{appointment}}. ممكن رقم موبايلك؟', booked(true), 'ar')).toBe(
      `تمام يا أحمد، ${TIME}.\n${T.confirmed}\nممكن رقم موبايلك؟`
    )
    expect(renderReply('حجزتلك {{appointment}}. تحب الحجز لزرعة الأسنان؟', booked(false), 'ar')).toBe(
      `حجزتلك ${TIME}.\n${T.pending}\nتحب الحجز لزرعة الأسنان؟`
    )
  })

  it('at the end when the appointment is the last thing said', () => {
    expect(renderReply('تمام، حجزتلك {{appointment}}.', booked(true), 'ar')).toBe(`تمام، حجزتلك ${TIME}.\n${T.confirmed}`)
    expect(renderReply('أهلاً يا كريم. حجزتلك {{appointment}}', booked(true), 'ar')).toBe(
      `أهلاً يا كريم. حجزتلك ${TIME}\n${T.confirmed}`
    )
  })

  it('once, after the last sentence that states it, when the reply states it twice', () => {
    expect(renderReply('حجزتلك {{appointment}}. مستنيينك {{appointment}}. محتاج حاجة تانية؟', booked(true), 'ar')).toBe(
      `حجزتلك ${TIME}. مستنيينك ${TIME}.\n${T.confirmed}\nمحتاج حاجة تانية؟`
    )
  })

  it('after the line the system adds when the reply never stated the appointment', () => {
    expect(renderReply('تمام يا أحمد. ممكن رقم موبايلك؟', booked(true), 'ar')).toBe(
      `تمام يا أحمد. ممكن رقم موبايلك؟\n${T.bookedConfirmed.replace('{time}', TIME)}`
    )
  })
})
