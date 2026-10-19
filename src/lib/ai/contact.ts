import { isOnlyANumber, normalizePhone, phoneLikeRuns, toLatinDigits } from '@/lib/phone'

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
 * A full name: at least two words, each of two letters or more, letters only
 * (any script; tashkeel, an apostrophe or a hyphen inside a word are fine).
 * Returns it with its spacing tidied, or null.
 */
export function validateName(input: string | null | undefined): string | null {
  const name = (input ?? '').trim().replace(/\s+/g, ' ')
  const words = name.split(' ')
  if (words.length < 2) return null
  const fullWords = words.every((word) => NAME_TOKEN.test(word) && word.replace(MARKS, '').length >= 2)
  return fullWords ? name : null
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
  visitorMessages: string[]
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
  const full = validateName(given)
  if (full) {
    state.name = full
    state.nameIncomplete = false
    state.pendingName = null
    events.name = 'stored'
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
export function describeContact(state: ContactState): string {
  const lines = [
    state.name
      ? "The visitor's name is on record: don't ask for it again."
      : state.pendingName
        ? "The visitor gave a name that is not a full one: don't ask for it again, whatever they answer; the system takes it as given."
        : "The visitor's name is not on record yet: the system asks for it once the appointment is complete, so don't ask for it yourself.",
    state.phone
      ? "The visitor's phone number is on record: don't ask for it again."
      : state.phoneRejections >= MAX_PHONE_REJECTIONS
        ? 'The visitor has sent numbers that are not phone numbers, and the team will take their number: do NOT ask for a phone number again.'
        : "The visitor's phone number is not on record yet: the system asks for it after the name, so don't ask for it yourself.",
  ]
  return `What the system holds for this visitor (before their latest message):\n${lines.map((line) => `- ${line}`).join('\n')}`
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
