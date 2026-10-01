import { describe, expect, it } from 'vitest'
import { appointmentRequestSchema, formatAppointment, resolveAppointment } from '@/lib/ai/appointment'

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

const at = (iso: string, approximate = false) => ({ status: 'resolved', at: iso, approximate })
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
      expect(resolve(nine, null, hours('16:00', '22:00'))).toEqual(at('2026-10-06T18:00:00.000Z'))
    })

    it('is the morning for a business open 8 AM to 4 PM', () => {
      expect(resolve(nine, null, hours('08:00', '16:00'))).toEqual(at('2026-10-06T06:00:00.000Z'))
    })

    it('follows opening hours that run past midnight, but asks about the small hours', () => {
      const lateNight = hours('18:00', '02:00')
      expect(resolve(nine, null, lateNight)).toEqual(at('2026-10-06T18:00:00.000Z'))
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
    ['a time already gone today', { day_type: 'today', hour: 9, period: 'morning' }],
    ['a date that does not exist', { day_type: 'date', day_of_month: 31, month: 11, hour: 17 }],
    ['more than six months ahead', { day_type: 'date', day_of_month: 1, month: 9, hour: 17 }],
    ['values out of range', { day_type: 'tomorrow', hour: 40 }],
  ])('returns nothing rather than guess: %s', (_name, request) => {
    expect(resolve(request)).toEqual(NONE)
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
