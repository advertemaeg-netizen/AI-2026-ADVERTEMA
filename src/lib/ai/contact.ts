import { isOnlyANumber, normalizePhone, phoneLikeRuns, toLatinDigits } from '@/lib/phone'
import {
  APPOINTMENT_NAME_NOT_YET_AR,
  DAY_ONLY_NAME_NOT_YET_AR,
  DAY_ONLY_PHONE_NOT_YET_AR,
  NAME_ON_RECORD_AR,
  NONE_NAME_NOT_YET_AR,
  NONE_PHONE_NOT_YET_AR,
  PARTIAL_NAME_AR,
  PHONE_GIVEN_UP_AR,
  PHONE_ON_RECORD_AR,
  RECORD_HEADER_AR,
} from '@/lib/ai/prompts-ar'
import type { BookingMode, NameStrictness } from '@/lib/types/bot-settings'

/**
 * The visitor's name and phone number, as the conversation establishes them.
 *
 * The chat model only reports what the visitor wrote ("contact" in its
 * answer). Whether that is a usable name or a real phone number is decided
 * here, before the reply is rendered — so the reply can never tell a visitor
 * that a number "arrived" when nothing was stored. It did exactly that until
 * October 2026: the checks existed, but ran after the reply had been sent.
 */

/** What the chat model reported the visitor's latest message to hold */
export type ContactReport = { name?: string | null; phone?: string | null }

/** Where the conversation stands; kept with each reply (messages.metadata.contact) */
export type ContactState = {
  name: string | null
  /** Accepted after one re-ask without being a full name: information for the team, not a block */
  nameIncomplete: boolean
  /** A name that failed the check and was asked about once; accepted on the next message */
  pendingName: string | null
  /** E.164 */
  phone: string | null
  /** Numbers the visitor sent that are not phone numbers */
  phoneRejections: number
}

export const EMPTY_CONTACT: ContactState = {
  name: null,
  nameIncomplete: false,
  pendingName: null,
  phone: null,
  phoneRejections: 0,
}

/** After this many unusable numbers the bot stops asking: a person takes the number */
export const MAX_PHONE_REJECTIONS = 2

export type ContactEvents = {
  /** 'ask_again': not a full name, asked about once. 'stored_incomplete': the escape hatch */
  name: 'none' | 'stored' | 'stored_incomplete' | 'ask_again'
  /** 'rejected_final': rejected, and the bot will not ask for it again */
  phone: 'none' | 'stored' | 'rejected' | 'rejected_final'
}

const NAME_TOKEN = /^[\p{L}\p{M}]+(?:['’\-][\p{L}\p{M}]+)*$/u
const MARKS = /\p{M}/gu

/**
 * A name as the business asks for it. 'two_parts': at least two words, each
 * of two letters or more. 'single': whatever name the visitor gives, one word
 * or more. Either way letters only (any script; tashkeel, an apostrophe or a
 * hyphen inside a word are fine): digits are not a name. Returns it with its
 * spacing tidied, or null.
 */
export function validateName(input: string | null | undefined, strictness: NameStrictness = 'two_parts'): string | null {
  const name = (input ?? '').trim().replace(/\s+/g, ' ')
  if (!name) return null
  const words = name.split(' ')
  if (!words.every((word) => NAME_TOKEN.test(word))) return null
  if (strictness === 'single') return name
  if (words.length < 2) return null
  return words.every((word) => word.replace(MARKS, '').length >= 2) ? name : null
}

// Spelling the model may tidy when it copies a name: hamzas, ى/ي, ة/ه, tatweel, case
const loose = (text: string) =>
  text
    .replace(MARKS, '')
    .replace(/ـ/g, '')
    .replace(/[أإآٱ]/g, 'ا')
    .replace(/ى/g, 'ي')
    .replace(/ة/g, 'ه')
    .toLowerCase()
const wordsOf = (text: string) => loose(text).split(/[^\p{L}'’\-]+/u).filter(Boolean)

/**
 * The model reports; it does not supply. A name is the visitor's only if
 * every word of it is in something they wrote.
 */
function writtenByVisitor(name: string, visitorMessages: string[]) {
  const written = new Set(visitorMessages.flatMap(wordsOf))
  const words = wordsOf(name)
  return words.length > 0 && words.every((word) => written.has(word))
}

/**
 * One visitor message → the contact state after it, and what happened.
 *
 * Phone: found by code in the message itself; the model's report only says
 * that the visitor meant to give one. A valid number is stored. A number
 * that isn't one is rejected, and the reply says what is wrong instead of
 * whatever the model wrote.
 *
 * Name: the model reports it, code checks it. A name that isn't a full name
 * is asked about once; on the visitor's next message, whatever that message
 * is about, what they gave is accepted and flagged as incomplete. One re-ask,
 * never a loop: a real patient must not be trapped by a rule about names.
 */
export function readContact(
  previous: ContactState,
  report: ContactReport | null,
  message: string,
  /** Every message the visitor wrote in this conversation, this one included */
  visitorMessages: string[],
  /** How much of a name the business asks for (bot_settings.name_strictness) */
  strictness: NameStrictness = 'two_parts'
): { state: ContactState; events: ContactEvents } {
  const state: ContactState = { ...previous }
  const events: ContactEvents = { name: 'none', phone: 'none' }

  const runs = phoneLikeRuns(message)
  const valid = runs.map(normalizePhone).find(Boolean) ?? normalizePhone(isOnlyANumber(message) ? message : null)
  const reported = (report?.phone ?? '').trim()
  // The model says a number was given and its digits are in the message, or
  // the message is nothing but a number
  const digitsOf = (text: string) => toLatinDigits(text).replace(/\D/g, '')
  const attempted =
    isOnlyANumber(message) ||
    (runs.length > 0 && reported !== '') ||
    // A few digits the model took for a number ("010"): too short to find alone
    (digitsOf(reported).length >= 3 && digitsOf(message).includes(digitsOf(reported)))
  if (valid) {
    state.phone = valid
    events.phone = 'stored'
  } else if (attempted) {
    state.phoneRejections += 1
    events.phone = state.phoneRejections >= MAX_PHONE_REJECTIONS ? 'rejected_final' : 'rejected'
  }

  const reportedName = (report?.name ?? '').trim().replace(/\s+/g, ' ')
  const given = reportedName && writtenByVisitor(reportedName, visitorMessages) ? reportedName : null
  const full = validateName(given, strictness)
  if (full) {
    // Stored is news only when it changes the record: the model repeating a
    // name already held is not the visitor giving it (nor a new lead)
    if (full !== previous.name || previous.nameIncomplete || previous.pendingName !== null) events.name = 'stored'
    state.name = full
    state.nameIncomplete = false
    state.pendingName = null
  } else if (previous.pendingName !== null) {
    // Asked once already: take what they gave, then or now
    state.name = given ?? previous.pendingName
    state.nameIncomplete = true
    state.pendingName = null
    events.name = 'stored_incomplete'
  } else if (given && state.name === null) {
    state.pendingName = given
    events.name = 'ask_again'
  }

  return { state, events }
}

/**
 * THE BOOKING GATE, for the assistant's two paths (the reply, and the
 * analysis of a message it didn't answer): an appointment is written only
 * when a name and a valid phone number are on record. Returns what is
 * missing. A person booking by hand in the dashboard takes that
 * responsibility themselves and is not held to it
 * (src/lib/actions/appointments.ts).
 *
 * TODO(branches): the branch is not part of the gate yet. leads.branch is
 * whatever the model reported, and there is no list of a client's branches
 * to check it against; a check without one would be a fake. It joins the
 * gate with the branches table, which also brings per-branch hours and slot
 * capacity.
 */
export function missingDetails(name: string | null, phone: string | null): ('name' | 'phone')[] {
  return [...(name?.trim() ? [] : (['name'] as const)), ...(normalizePhone(phone) ? [] : (['phone'] as const))]
}

/**
 * What the chat model is told about the record before it writes: which of
 * the two details are on record, and that it does not ask for either: code
 * asks for the name and then the number once a time is held (the booking
 * order). Without it the model would go on asking for a number the system has
 * given up on — the loop the escape hatch exists to prevent, moved into the
 * model.
 */
export function describeContact(state: ContactState, mode: BookingMode = 'appointment'): string {
  // The copy owner's Arabic (prompts-ar.ts), in every mode since 26 October
  // 2026: one chain of authority reads in one language. Only what the system
  // asks after differs by booking shape, so the not-yet lines are the
  // shape's; everything else is said the same way whatever the shape.
  const notYet = {
    appointment: { name: APPOINTMENT_NAME_NOT_YET_AR, phone: DAY_ONLY_PHONE_NOT_YET_AR },
    day_only: { name: DAY_ONLY_NAME_NOT_YET_AR, phone: DAY_ONLY_PHONE_NOT_YET_AR },
    none: { name: NONE_NAME_NOT_YET_AR, phone: NONE_PHONE_NOT_YET_AR },
  }[mode]
  const lines = [
    // On record says it is on record, never what it is: the reply quotes the values through placeholders
    state.name ? NAME_ON_RECORD_AR : state.pendingName ? PARTIAL_NAME_AR : notYet.name,
    state.phone ? PHONE_ON_RECORD_AR : state.phoneRejections >= MAX_PHONE_REJECTIONS ? PHONE_GIVEN_UP_AR : notYet.phone,
  ]
  return `${RECORD_HEADER_AR}\n${lines.map((line) => `- ${line}`).join('\n')}`
}

/** messages.metadata.contact → the state, tolerant of what older messages hold */
export function parseContactState(value: unknown): ContactState | null {
  if (!value || typeof value !== 'object') return null
  const v = value as Record<string, unknown>
  const text = (x: unknown) => (typeof x === 'string' && x.trim() ? x : null)
  return {
    name: text(v.name),
    nameIncomplete: v.nameIncomplete === true,
    pendingName: text(v.pendingName),
    phone: normalizePhone(text(v.phone)),
    phoneRejections: typeof v.phoneRejections === 'number' ? v.phoneRejections : 0,
  }
}
