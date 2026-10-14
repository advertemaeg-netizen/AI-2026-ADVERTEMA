import { describe, expect, it } from 'vitest'
import ar from '../../messages/ar.json'
import { appointmentRequestSchema, formatAppointment, renderReply, resolveAppointment } from '@/lib/ai/appointment'

// Monday 5 October 2026, 12:00 in Cairo (UTC+3)
const now = new Date('2026-10-05T09:00:00.000Z')
type Hours = Parameters<typeof resolveAppointment>[1] extends infer O ? NonNullable<O> extends { businessHours?: infer H } ? H : never : never

const resolve = (request: Record<string, unknown>, keepDayOf: string | null = null, businessHours: Hours = null) =>
  resolveAppointment(appointmentRequestSchema.parse({ period: 'unspecified', ...request }), { now, keepDayOf, businessHours })

/** Open every day but Friday, `from`–`to` */
const hours = (from: string, to: string): Hours => ({
  enabled: true,
  timezone: 'Africa/Cairo',
  days: Object.fromEntries(
    ['sat', 'sun', 'mon', 'tue', 'wed', 'thu', 'fri'].map((day) => [day, { open: day !== 'fri', from, to }])
  ) as NonNullable<Hours>['days'],
})

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
    ['no day and nothing on record', { day_type: 'none', hour: 17 }],
    ['a day with no time at all', { day_type: 'tomorrow' }],
    ['a weekday type without the weekday', { day_type: 'weekday', hour: 17 }],
    ['a date that does not exist', { day_type: 'date', day_of_month: 31, month: 11, hour: 17 }],
    ['more than six months ahead', { day_type: 'date', day_of_month: 1, month: 9, hour: 17 }],
    ['values out of range', { day_type: 'tomorrow', hour: 40 }],
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
        hours: { weekday: 2, open: true, from: '12:00', to: '22:00' },
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

describe('a reply about a time that did not become an appointment', () => {
  const T = ar.botReplies.appointment

  it('says the hours of that day, and drops what the model wrote about the booking', () => {
    const outcome = { status: 'outside_hours', hours: { weekday: 2, open: true, from: '12:00', to: '22:00' } } as const
    expect(renderReply('تمام، هسجل طلبك {{appointment}}. محتاج حاجة تانية؟', outcome, 'ar')).toBe(
      'محتاج حاجة تانية؟\nالميعاد ده برّه مواعيد العمل: يوم الثلاثاء بنشتغل من 12:00 ظهراً لـ 10:00 مساءً. تحب ساعة تانية؟'
    )
    expect(renderReply('حجزتلك {{appointment}}.', { status: 'outside_hours', hours: { weekday: 5, open: false } }, 'ar')).toBe(
      T.closedDay.replace('{day}', 'الجمعة')
    )
  })

  it('says what is missing when the name or the number is not on record', () => {
    const at = '2026-10-08T15:00:00.000Z'
    const time = 'الخميس 8 أكتوبر الساعة 6:00 مساءً'
    expect(renderReply('حجزتلك {{appointment}}.', { status: 'needs_details', at, missing: ['name', 'phone'], handoff: false }, 'ar')).toBe(
      `عشان أثبّت الحجز يوم ${time} محتاج اسمك بالكامل ورقم موبايلك.`
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
