import { describe, expect, it } from 'vitest'
import { appointmentRequestSchema } from '@/lib/ai/appointment'
import { withEvidence } from '@/lib/ai/evidence'

/**
 * Nothing the model reports about a booking is taken without a trace of it
 * in the visitor's own message on that turn. Fails toward dropping.
 */

const request = (fields: Record<string, unknown>) => appointmentRequestSchema.parse({ period: 'unspecified', ...fields })
const check = (fields: Record<string, unknown>, message: string) => withEvidence(request(fields), message)

describe('a part the visitor never said is dropped', () => {
  // The four shapes of the "returns nothing rather than guess" table, decided by one rule
  it('an hour with no day, in a message with no number: the invented 5 of "الأسبوع الجاي"', () => {
    const { request: kept, dropped } = check({ day_type: 'none', hour: 5, period: 'afternoon' }, 'عايز أحجز الأسبوع الجاي')
    expect(dropped).toEqual(['hour', 'period'])
    expect(kept).toMatchObject({ day_type: 'none', hour: null, period: 'unspecified' })
  })

  it('an hour with no day, in a message that gives it: kept', () => {
    expect(check({ day_type: 'none', hour: 17 }, 'عندكم حاجة الساعة 17؟').dropped).toEqual([])
  })

  it('a weekday with no name: the day is dropped, the hour stands on its own evidence', () => {
    expect(check({ day_type: 'weekday', weekday: null, hour: 5 }, 'الساعة 5').dropped).toEqual(['day'])
    expect(check({ day_type: 'weekday', weekday: null, hour: 5 }, 'الأسبوع الجاي').dropped).toEqual(['day', 'hour'])
  })

  // An hour of 40 is no hour (the schema drops it): the day decides
  it('an impossible hour: the day is kept if it was said, dropped with it if not', () => {
    expect(check({ day_type: 'tomorrow', hour: 40 }, 'بكرة الساعة 40')).toMatchObject({ dropped: [], request: { day_type: 'tomorrow', hour: null } })
    expect(check({ day_type: 'tomorrow', hour: 40 }, 'تمام').dropped).toEqual(['day'])
  })

  it('restated parts of earlier messages: dropped (the draft holds what was really said)', () => {
    // Conversation 0c6b8d64: "الصبح" reported as Thursday at 11 in the morning
    expect(check({ day_type: 'weekday', weekday: 'thursday', hour: 11, period: 'morning' }, 'الصبح').dropped).toEqual(['day', 'hour'])
    // and "م انا قولتلك" as the whole booking
    expect(check({ day_type: 'weekday', weekday: 'thursday', hour: 7, period: 'night' }, 'م انا قولتلك').dropped).toEqual(['day', 'hour', 'period'])
  })

  it('digits inside a phone number are not an hour', () => {
    expect(check({ day_type: 'none', hour: 1 }, 'رقمي 01097654189').dropped).toEqual(['hour'])
  })

  it('morning is never taken from an evening word, nor the reverse', () => {
    expect(check({ day_type: 'none', hour: 7, period: 'morning' }, '7 بالليل').dropped).toEqual(['period'])
    expect(check({ day_type: 'none', hour: 7, period: 'night' }, '7 الصبح').dropped).toEqual(['period'])
  })

  it('tomorrow is not the day after tomorrow, nor the reverse', () => {
    expect(check({ day_type: 'tomorrow', hour: 5 }, 'بعد بكرة الساعة 5').dropped).toEqual(['day'])
    expect(check({ day_type: 'day_after_tomorrow', hour: 5 }, 'بكرة الساعة 5').dropped).toEqual(['day'])
  })

  it('a date needs to read as a date, its month and its year as said', () => {
    expect(check({ day_type: 'date', day_of_month: 5, hour: 5 }, 'الساعة 5').dropped).toEqual(['day'])
    expect(check({ day_type: 'date', day_of_month: 25, month: 1, hour: 5 }, 'يوم 25 الساعة 5').dropped).toEqual(['day'])
    expect(check({ day_type: 'date', day_of_month: 25, month: 1, year: 2027, hour: 5 }, '25 يناير الساعة 5').dropped).toEqual(['day'])
  })

  it('a minute nobody said', () => {
    expect(check({ day_type: 'none', hour: 7, minute: 30 }, 'الساعة 7').dropped).toEqual(['minute'])
  })
})

describe('what the visitor did say is kept', () => {
  it.each([
    ['the turn that was withheld', { day_type: 'none', hour: 7, period: 'night' }, '7 بالليل'],
    ['a weekday and an hour', { day_type: 'weekday', weekday: 'thursday', hour: 11 }, 'الخميس الساعة 11'],
    ['Arabic-Indic digits', { day_type: 'tomorrow', hour: 7, period: 'evening' }, 'بكره الساعة ٧ مساءً'],
    ['an hour in words', { day_type: 'weekday', weekday: 'saturday', hour: 7, period: 'evening' }, 'السبت الساعة سبعة المغرب'],
    ['ونص', { day_type: 'today', hour: 11, minute: 30, period: 'night' }, 'النهارده 11 ونص بالليل'],
    ['7:45', { day_type: 'none', hour: 7, minute: 45 }, 'خليها 7:45'],
    ['"7 إلا ربع" reported as 6:45', { day_type: 'none', hour: 6, minute: 45 }, 'خليها 7 إلا ربع'],
    ['بعد الظهر', { day_type: 'tomorrow', hour: 1, period: 'afternoon' }, 'بكرة 1 بعد الظهر'],
    ['a 24-hour time reported on the 12-hour clock', { day_type: 'none', hour: 7, period: 'evening' }, 'الساعة 19 مساء'],
    ['يوم الحد', { day_type: 'weekday', weekday: 'sunday', hour: 6, period: 'evening' }, 'يوم الحد الساعة 6 المغرب'],
    ['a date with its month', { day_type: 'date', day_of_month: 25, month: 1, hour: 5, period: 'afternoon' }, '25 يناير الساعة 5 العصر'],
    ['a day alone', { day_type: 'weekday', weekday: 'thursday' }, 'عايز أحجز يوم الخميس'],
    ['an English message', { day_type: 'tomorrow', hour: 5, period: 'afternoon' }, 'Tomorrow at 5 in the afternoon'],
  ])('%s', (_name, fields, message) => {
    expect(check(fields, message).dropped).toEqual([])
  })
})
