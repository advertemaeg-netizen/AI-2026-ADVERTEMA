// Egyptian mobile numbers: 010 / 011 / 012 / 015 + 8 digits
const EGYPT_MOBILE = /^01[0125]\d{8}$/

const ARABIC_INDIC_DIGITS = /[٠-٩۰-۹]/g

/**
 * Normalizes an Egyptian mobile number to 01XXXXXXXXX, accepting Arabic-Indic
 * digits, spaces/dashes and +20 / 0020 / 20 prefixes. Null if it isn't one.
 */
export function normalizeEgyptianPhone(input: string | null | undefined): string | null {
  if (!input) return null
  let digits = input
    .replace(ARABIC_INDIC_DIGITS, (d) => String('٠١٢٣٤٥٦٧٨٩۰۱۲۳۴۵۶۷۸۹'.indexOf(d) % 10))
    .replace(/\D/g, '')

  if (digits.startsWith('0020')) digits = digits.slice(4)
  else if (digits.startsWith('20') && digits.length === 12) digits = digits.slice(2)
  if (digits.length === 10 && digits.startsWith('1')) digits = `0${digits}`

  return EGYPT_MOBILE.test(digits) ? digits : null
}

export function telHref(phone: string) {
  return `tel:${phone}`
}

/** https://wa.me/20 + the number without its leading zero */
export function whatsappHref(phone: string) {
  return `https://wa.me/20${phone.replace(/^0/, '')}`
}
