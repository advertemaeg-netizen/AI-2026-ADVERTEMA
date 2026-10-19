import 'server-only'
import nodemailer, { type Transporter } from 'nodemailer'
import { z } from 'zod'
import { SITE_EMAIL } from '@/site/config'

/**
 * The contact form's message, sent by mail to SITE_EMAIL over SMTP: the
 * mailbox's own provider, so nothing else has to verify the domain. Set
 * CONTACT_SMTP_HOST, CONTACT_SMTP_PORT (465: TLS from the start; anything
 * else upgrades with STARTTLS), CONTACT_SMTP_USER and CONTACT_SMTP_PASS on
 * the server; CONTACT_SMTP_FROM if the account sends as another address.
 *
 * Sent means the SMTP server accepted the message for SITE_EMAIL. That is
 * all the form may claim: without the settings, or on any refusal or error,
 * nothing was sent and the visitor is told so (contact.form.error).
 */

export const contactSchema = z.object({
  name: z.string().trim().min(1).max(120),
  business: z.string().trim().max(160).default(''),
  // As typed: a Saudi number is as welcome as an Egyptian one. Enough digits to dial, no more
  phone: z
    .string()
    .trim()
    .max(40)
    .refine((value) => {
      const digits = value.replace(/[^\d٠-٩]/g, '').length
      return digits >= 7 && digits <= 15
    }),
  email: z.union([z.literal(''), z.string().trim().email().max(200)]).default(''),
  message: z.string().trim().min(1).max(4000),
  locale: z.enum(['ar', 'en']).catch('ar'),
})

export type ContactMessage = z.infer<typeof contactSchema>

/** The mail itself: plain text, the visitor's address as Reply-To when they gave one */
export function contactMail(message: ContactMessage, from: string) {
  const lines = [
    `Name: ${message.name}`,
    `Business: ${message.business || '—'}`,
    `Mobile: ${message.phone}`,
    `Email: ${message.email || '—'}`,
    `Page language: ${message.locale}`,
    '',
    message.message,
  ]
  return {
    from,
    to: SITE_EMAIL,
    ...(message.email ? { replyTo: message.email } : {}),
    // A name on one line: a header must not carry a line break
    subject: `Mudrik contact form: ${message.name.replace(/[\r\n]+/g, ' ')}`,
    text: lines.join('\n'),
  }
}

type Transport = Pick<Transporter, 'sendMail'>

function smtpTransport(): { transport: Transport; from: string } | null {
  const { CONTACT_SMTP_HOST: host, CONTACT_SMTP_PORT: port, CONTACT_SMTP_USER: user, CONTACT_SMTP_PASS: pass } = process.env
  if (!host || !user || !pass) return null
  const portNumber = Number(port ?? 465)
  return {
    transport: nodemailer.createTransport({
      host,
      port: portNumber,
      secure: portNumber === 465,
      requireTLS: portNumber !== 465,
      auth: { user, pass },
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    }),
    from: process.env.CONTACT_SMTP_FROM || user,
  }
}

/** True only when the SMTP server accepted the message for SITE_EMAIL; never throws */
export async function sendContactMail(message: ContactMessage, smtp = smtpTransport()): Promise<boolean> {
  if (!smtp) {
    console.error('[site/contact] not sent: CONTACT_SMTP_HOST, CONTACT_SMTP_USER and CONTACT_SMTP_PASS are not all set')
    return false
  }
  try {
    const info = await smtp.transport.sendMail(contactMail(message, smtp.from))
    const accepted = (info.accepted ?? []).map((address: string | { address: string }) => (typeof address === 'string' ? address : address.address).toLowerCase())
    const sent = accepted.includes(SITE_EMAIL) && (info.rejected ?? []).length === 0
    if (!sent) console.error('[site/contact] the SMTP server did not accept the message', { accepted: info.accepted, rejected: info.rejected })
    return sent
  } catch (error) {
    console.error('[site/contact] sending failed', error)
    return false
  }
}
