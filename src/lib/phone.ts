/**
 * Phone numbers. One stored format, E.164 ("+201003462718"): what the
 * visitor typed is never stored. Everything that shows, dials or links a
 * number starts from that one value.
 */

// Egyptian mobile numbers: 010 / 011 / 012 / 015 + 8 digits
const EGYPT_MOBILE_LOCAL = /^01[0125]\d{8}$/
const EGYPT_MOBILE_INTERNATIONAL = /^201[0125]\d{8}$/
// Any other country: E.164 allows up to 15 digits, and none starts with 0
const INTERNATIONAL = /^[1-9]\d{7,14}$/

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g

/** Arabic-Indic and Persian digits → Latin */
export function toLatinDigits(text: string) {
  return text.replace(ARABIC_INDIC_DIGITS, (d) => String('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'.indexOf(d) % 10))
}

/**
 * A phone number as E.164, or null when it isn't one the team can reach.
 *
 * Accepted: an Egyptian mobile in any of its shapes (01XXXXXXXXX,
 * 201XXXXXXXXX, +201XXXXXXXXX, 00201XXXXXXXXX), or a number of another
 * country written internationally ("+" or "00", then 8 to 15 digits) — a
 * relative abroad booking for family is a real case, and WhatsApp reaches
 * them. Arabic-Indic digits, spaces, dashes, dots and parentheses are read
 * through.
 *
 * Refused: everything else. That includes Egyptian landlines, with or
 * without +20 (the follow-up is on WhatsApp, which needs a mobile), and a
 * foreign number written without its "+": nothing says which country it is.
 */
export function normalizePhone(input: string | null | undefined): string | null {
  if (!input) return null
  const text = toLatinDigits(input).trim()
  let digits = text.replace(/\D/g, '')
  const international = /^(\+|00)/.test(text)
  if (text.startsWith('00')) digits = digits.slice(2)

  if (!international && EGYPT_MOBILE_LOCAL.test(digits)) return `+2${digits}`
  if (EGYPT_MOBILE_INTERNATIONAL.test(digits)) return `+${digits}`
  if (international && !digits.startsWith('20') && INTERNATIONAL.test(digits)) return `+${digits}`
  return null
}

// The fewest digits that read as an attempt at a phone number
const MIN_PHONE_LIKE_DIGITS = 7

/**
 * The digit runs in a text that could be a phone number, as written (digits
 * and a leading "+" only): "رقمي 0100 284 7901" → ["01002847901"]. Whether
 * one of them is a phone number is normalizePhone's to say.
 */
export function phoneLikeRuns(text: string): string[] {
  const runs = toLatinDigits(text).match(/(?:\+|00)?\d(?:[\s\-.()]{0,2}\d){5,}/g) ?? []
  return runs
    .map((run) => (run.trim().startsWith('+') ? '+' : '') + run.replace(/\D/g, ''))
    .filter((run) => run.replace(/\D/g, '').length >= MIN_PHONE_LIKE_DIGITS)
}

// "13-10-2026", "13.10": an answer to "which day?", not a phone number
const DATE_LIKE = /^\d{1,2}[\-.]\d{1,2}(?:[\-.]\d{2,4})?$/

/** A message that is nothing but a number: "879995233130", "0100 284-7901" */
export function isOnlyANumber(text: string) {
  const latin = toLatinDigits(text).trim()
  if (DATE_LIKE.test(latin)) return false
  return /^\+?[\d\s\-.()]+$/.test(latin) && latin.replace(/\D/g, '').length >= MIN_PHONE_LIKE_DIGITS
}

/**
 * How a stored number is shown: an Egyptian mobile in the local form the
 * receptionist recognises and dials (01003462718); any other number as stored.
 */
export function displayPhone(phone: string) {
  const digits = phone.replace(/\D/g, '')
  return EGYPT_MOBILE_INTERNATIONAL.test(digits) ? `0${digits.slice(2)}` : phone
}

/** The digits wa.me and tel: need: country code first, nothing but digits */
function internationalDigits(phone: string) {
  const digits = phone.replace(/\D/g, '')
  // Rows stored before E.164 hold the local form (01XXXXXXXXX)
  return EGYPT_MOBILE_LOCAL.test(digits) ? `2${digits}` : digits
}

export function telHref(phone: string) {
  return `tel:+${internationalDigits(phone)}`
}

/**
 * https://wa.me/ + the number's digits. Built from the digits alone: the
 * link once put "20" in front of a number that already carried "+20"
 * (wa.me/20+201003462718).
 */
export function whatsappHref(phone: string) {
  return `https://wa.me/${internationalDigits(phone)}`
}
