'use server'

import { headers } from 'next/headers'
import { contactSchema, sendContactMail } from '@/site/contact-mail'

export type ContactResult = { ok: boolean }

// A loose guard against a script filling the inbox, per server instance: not
// a security control. Over it, the visitor is told it didn't send (WhatsApp
// always works), never that it did.
const WINDOW_MS = 60 * 60 * 1000
const MAX_PER_WINDOW = 5
const recent = new Map<string, number[]>()

function allowed(key: string, now = Date.now()) {
  const times = (recent.get(key) ?? []).filter((t) => now - t < WINDOW_MS)
  if (times.length >= MAX_PER_WINDOW) {
    recent.set(key, times)
    return false
  }
  recent.set(key, [...times, now])
  return true
}

/**
 * The site's contact form. `ok` is true only when the message was accepted
 * for delivery to the mailbox (sendContactMail): the page says "we got it" on
 * that and nothing else. A field a person leaves empty and a bot fills
 * ("website") is not sent either.
 */
export async function sendContactMessage(formData: FormData): Promise<ContactResult> {
  if (String(formData.get('website') ?? '') !== '') return { ok: false }
  const parsed = contactSchema.safeParse(Object.fromEntries(formData))
  if (!parsed.success) return { ok: false }

  const forwarded = (await headers()).get('x-forwarded-for')?.split(',')[0]?.trim()
  if (!allowed(forwarded || 'unknown')) return { ok: false }

  return { ok: await sendContactMail(parsed.data) }
}
