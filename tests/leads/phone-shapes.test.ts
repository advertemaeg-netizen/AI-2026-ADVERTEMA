import { describe, expect, it } from 'vitest'
import { EMPTY_CONTACT, readContact } from '@/lib/ai/contact'

/**
 * A message that holds a phone number is either stored or rejected out loud:
 * never neither. Until October 2026 five shapes were silently dropped —
 * nothing stored, no rejection — when the model didn't report the number:
 * a direction mark between the groups (what a phone inserts when a number is
 * copied out of its contacts in an Arabic interface), a joiner, and «/», «_»
 * or «،» between the groups.
 *
 * Every case runs with no model report: code reads the number from the
 * message alone (readContact).
 */
const outcome = (message: string) => {
  const { state, events } = readContact(EMPTY_CONTACT, null, message, [message])
  return state.phone ?? events.phone
}

const LRM = '‎'
const RLM = '‏'
const ALM = '؜'
const ZWJ = '‍'
const FSI = '⁨'
const PDI = '⁩'
const NBSP = ' '
const STORED = '+201012345678'

describe('every shape a phone number arrives in', () => {
  it.each([
    ['plain', '01012345678', STORED],
    ['Arabic-Indic digits', '٠١٠١٢٣٤٥٦٧٨', STORED],
    ['spaced', '010 1234 5678', STORED],
    ['dashes', '010-1234-5678', STORED],
    ['+20, spaced', '+20 10 1234 5678', STORED],
    ['+20 in Arabic-Indic digits', '+٢٠١٠١٢٣٤٥٦٧٨', STORED],
    ['0020', '00201012345678', STORED],
    ['no-break spaces', `010${NBSP}1234${NBSP}5678`, STORED],
    ['wrapped in LRM', `${LRM}01012345678${LRM}`, STORED],
    ['wrapped in RLM', `${RLM}01012345678${RLM}`, STORED],
    ['after an Arabic letter mark', `${ALM}01012345678`, STORED],
    ['in isolates, copied from a contact card', `${FSI}+20 10 1234 5678${PDI}`, STORED],
    ['LRM between the groups', `+20${LRM} 10${LRM} 1234${LRM} 5678`, STORED],
    ['a joiner inside', `0101234${ZWJ}5678`, STORED],
    ['a full stop after it', '01012345678.', STORED],
    ['an emoji after it', '01012345678 🙏', STORED],
    ['mixed Latin and Arabic-Indic digits', '010١٢٣٤٥٦٧٨', STORED],
    ['Persian digits', '۰۱۰۱۲۳۴۵۶۷۸', STORED],
    ['+ and 20 apart', '+ 20 101 234 5678', STORED],
    ['parentheses', '(+20) 101 234 5678', STORED],
    ['a slash between the groups', '010/12345678', STORED],
    ['underscores between the groups', '010_1234_5678', STORED],
    ['Arabic commas between the groups', '010،1234،5678', STORED],
    // Read, and not a number the team can reach: said so
    ['two numbers run together', '01012345678 01112345678', 'rejected'],
    ['ten digits, the leading zero missing', '1012345678', 'rejected'],
  ])('%s', (_name, message, expected) => {
    expect(outcome(message)).toBe(expected)
  })

  it('reads the number inside a sentence through the same separators', () => {
    expect(outcome(`رقمي 010${LRM} 1234${LRM} 5678`)).toBe(STORED)
    expect(outcome('رقمي 010/12345678')).toBe(STORED)
    expect(outcome('رقمي 010،1234،5678')).toBe(STORED)
  })

  it('keeps two numbers separated by «، » apart, and stores the first', () => {
    expect(outcome('01012345678، 01112345678')).toBe(STORED)
  })
})

describe('the next separator nobody has seen yet', () => {
  // Every invisible format character in the Basic Multilingual Plane
  const invisible = Array.from({ length: 0x10000 }, (_, i) => String.fromCharCode(i)).filter((c) => /^\p{Cf}$/u.test(c))
  // Every punctuation or symbol character someone could type between groups.
  // Not the operators + = * × ÷: "1900-500+200" is a sum, and stays one
  // (contact.test.ts, "leaves a sum, a date and a price alone").
  const typed = [...'!"#$%&\'(),-./:;<>?@[\\]^_`{|}~', '،', '؛', '٫', '٬', '؟', '·', '•', '–', '—', '٪']

  it('finds the invisible characters to test, the ones phones insert among them', () => {
    expect(invisible).toEqual(expect.arrayContaining([LRM, RLM, ALM, ZWJ, FSI, PDI]))
  })

  it.each(invisible.map((c) => [`U+${c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0')}`, c]))(
    'an invisible %s between the groups: the number is stored',
    (_code, c) => {
      expect(outcome(`010${c}1234${c}5678`)).toBe(STORED)
    }
  )

  it.each(typed.map((c) => [c]))('«%s» between the groups: stored or rejected, never ignored', (c) => {
    expect(outcome(`010${c}1234${c}5678`)).not.toBe('none')
  })
})

describe('a date is not a phone number', () => {
  it.each([['13/10/2026'], ['13/10'], ['2026/10/13'], ['13 / 10 / 2026'], ['13-10-2026'], ['2026-10-13'], ['13.10.2026']])(
    '%s is neither stored nor rejected',
    (message) => {
      expect(outcome(message)).toBe('none')
    }
  )

  it('leaves a date inside a sentence alone', () => {
    expect(outcome('يوم 13/10/2026 الساعة 5')).toBe('none')
  })
})
