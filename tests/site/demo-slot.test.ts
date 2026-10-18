import { describe, expect, it } from 'vitest'
import ar from '../../messages/ar.json'
import en from '../../messages/en.json'
import { formatAppointment } from '@/lib/ai/appointment'
import { demoSlotText } from '@/site/demo-slot'

/**
 * The hero conversation writes its appointment in the browser, apart from the
 * product's formatAppointment (which would bring zod and the message file
 * along). The two must write the same thing.
 */

const words = (m: typeof ar) => ({ at: m.botReplies.appointment.at, am: m.botReplies.appointment.am, noon: m.botReplies.appointment.noon, pm: m.botReplies.appointment.pm })

describe('the hero conversation’s appointment', () => {
  it.each([
    // now (UTC) → the product's own rendering of tomorrow 18:00 in Cairo
    ['a Sunday morning in Cairo', '2026-10-18T06:00:00Z', '2026-10-19T15:00:00Z'],
    ['late evening in Cairo, still the same day there', '2026-10-18T20:30:00Z', '2026-10-19T15:00:00Z'],
    ['just after midnight in Cairo (still the evening before in UTC)', '2026-10-18T21:30:00Z', '2026-10-20T15:00:00Z'],
    ['across the end of summer time (Cairo goes back on 29 October)', '2026-10-29T08:00:00Z', '2026-10-30T16:00:00Z'],
  ])('is tomorrow at 6 PM, written as the product writes it: %s', (_name, now, slot) => {
    expect(demoSlotText(new Date(now), 'ar', words(ar))).toBe(formatAppointment(slot, 'ar'))
    expect(demoSlotText(new Date(now), 'en', words(en))).toBe(formatAppointment(slot, 'en'))
  })
})
