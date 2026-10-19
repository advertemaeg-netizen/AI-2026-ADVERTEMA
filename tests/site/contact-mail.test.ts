import { afterEach, describe, expect, it, vi } from 'vitest'
import { SITE_EMAIL } from '@/site/config'
import { contactMail, contactSchema, sendContactMail } from '@/site/contact-mail'

/**
 * The contact form says "we got it" only when the mail was accepted for the
 * mailbox. Everything else is a failure the visitor is told about.
 */

const message = contactSchema.parse({
  name: 'Karim Samy',
  business: 'Smile Care',
  phone: '01002847901',
  email: 'karim@example.com',
  message: 'I would like the setup.',
  locale: 'en',
})

const transport = (sendMail: (mail: unknown) => Promise<unknown>) => ({ transport: { sendMail } as never, from: 'contact@mudrik-ai.com' })

afterEach(() => {
  vi.restoreAllMocks()
})

describe('the contact form is sent only when it is sent', () => {
  it('is sent when the server accepts it for the mailbox', async () => {
    expect(await sendContactMail(message, transport(async () => ({ accepted: [SITE_EMAIL], rejected: [] })))).toBe(true)
  })

  it('is not sent when the server refuses the mailbox, or accepts nothing', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await sendContactMail(message, transport(async () => ({ accepted: [], rejected: [SITE_EMAIL] })))).toBe(false)
    expect(await sendContactMail(message, transport(async () => ({})))).toBe(false)
  })

  it('is not sent when sending throws: a timeout, a wrong password, no network', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(
      await sendContactMail(
        message,
        transport(async () => {
          throw new Error('Invalid login')
        })
      )
    ).toBe(false)
  })

  it('is not sent, and says why in the log, when the SMTP settings are missing', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await sendContactMail(message, null)).toBe(false)
    expect(String(logged.mock.calls[0][0])).toContain('CONTACT_SMTP_HOST')
  })
})

describe('the mail', () => {
  it('goes to the site\'s address, with the visitor as the reply-to', () => {
    const mail = contactMail(message, 'contact@mudrik-ai.com')
    expect(mail).toMatchObject({ to: SITE_EMAIL, replyTo: 'karim@example.com' })
    expect(mail.text).toContain('01002847901')
    expect(mail.text).toContain('I would like the setup.')
  })

  it('keeps a line break in the name out of the subject header', () => {
    expect(contactMail({ ...message, name: 'A\r\nBcc: x@example.com' }, 'x').subject).not.toMatch(/[\r\n]/)
  })

  it('asks for a name, a number to call and a message; a business and an email are optional', () => {
    expect(contactSchema.safeParse({ name: 'K', phone: '+966 50 123 4567', message: 'hi' }).success).toBe(true)
    expect(contactSchema.safeParse({ name: '', phone: '01002847901', message: 'hi' }).success).toBe(false)
    expect(contactSchema.safeParse({ name: 'K', phone: '12', message: 'hi' }).success).toBe(false)
    expect(contactSchema.safeParse({ name: 'K', phone: '01002847901', message: ' ' }).success).toBe(false)
    expect(contactSchema.safeParse({ name: 'K', phone: '01002847901', message: 'hi', email: 'not an address' }).success).toBe(false)
  })
})
