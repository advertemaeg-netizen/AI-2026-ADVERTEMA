import { describe, expect, it } from 'vitest'
import ar from '../../messages/ar.json'
import en from '../../messages/en.json'
import { formatAppointment } from '@/lib/ai/appointment'
import { demoSlotText } from '@/site/demo-slot'

/**
 * The hero conversation writes its appointment in the browser, apart from the
 * product's formatAppointment (which would bring zod and the message file
 * along). The two must write the same thing, for the same day the product
 * would give «الخميس ٧ بالليل».
 */

const words = (m: typeof ar) => ({ at: m.botReplies.appointment.at, am: m.botReplies.appointment.am, noon: m.botReplies.appointment.noon, pm: m.botReplies.appointment.pm })

describe('the hero conversation’s appointment: the coming Thursday at 7 PM in Cairo', () => {
  it.each([
    // now (UTC) → that Thursday 19:00 Cairo, as an instant
    ['on a Sunday', '2026-10-18T06:00:00Z', '2026-10-22T16:00:00Z'],
    ['on the Thursday itself, before 7 PM: today', '2026-10-22T10:00:00Z', '2026-10-22T16:00:00Z'],
    ['on the Thursday itself, after 7 PM: next week', '2026-10-22T17:30:00Z', '2026-10-29T16:00:00Z'],
    ['late Wednesday in UTC, already Thursday in Cairo', '2026-10-21T22:30:00Z', '2026-10-22T16:00:00Z'],
    // Summer time ends at the END of Thursday 29 October: that evening is still UTC+3
    ['on the last Thursday of summer time', '2026-10-27T08:00:00Z', '2026-10-29T16:00:00Z'],
    ['after the clocks go back (UTC+2)', '2026-11-02T08:00:00Z', '2026-11-05T17:00:00Z'],
  ])('%s', (_name, now, slot) => {
    expect(demoSlotText(new Date(now), 'ar', words(ar))).toBe(formatAppointment(slot, 'ar'))
    expect(demoSlotText(new Date(now), 'en', words(en))).toBe(formatAppointment(slot, 'en'))
  })
})
