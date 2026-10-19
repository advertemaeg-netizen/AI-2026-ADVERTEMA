'use client'

import { useState } from 'react'
import { cn } from '@/lib/utils'
import { sendContactMessage } from '@/site/contact-action'
import { ctaPrimary } from '@/site/components/home-sections'

type Labels = {
  name: string
  business: string
  phone: string
  email: string
  message: string
  submit: string
  sending: string
  success: string
  error: string
}

const field =
  'min-h-12 w-full rounded-xl border border-primary/25 bg-white/95 px-4 py-3 text-base outline-none focus-visible:border-primary focus-visible:ring-2 focus-visible:ring-primary/40'

/**
 * The contact form. "We got it" is shown only when the server says the mail
 * was accepted (sendContactMessage); anything else — refused, not
 * configured, the network, an action from an older deploy — keeps what the
 * visitor typed and says it didn't send, with WhatsApp next to it, which
 * always works. A form that thanks someone for a message nobody received is
 * worse than no form.
 */
export function ContactForm({ locale, labels, whatsapp }: { locale: string; labels: Labels; whatsapp: { label: string; href: string } }) {
  const [state, setState] = useState<'idle' | 'sending' | 'sent' | 'error'>('idle')

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (state === 'sending') return
    const data = new FormData(event.currentTarget)
    setState('sending')
    try {
      const result = await sendContactMessage(data)
      setState(result?.ok === true ? 'sent' : 'error')
    } catch {
      setState('error')
    }
  }

  if (state === 'sent') {
    return (
      <p role="status" className="site-panel site-lead p-8 font-semibold">
        {labels.success}
      </p>
    )
  }

  return (
    <form onSubmit={submit} className="site-panel relative flex flex-col gap-5 p-6 md:p-8">
      <input type="hidden" name="locale" value={locale} />
      {/* Left empty by people, filled by bots: such a message is not sent */}
      <div aria-hidden className="absolute -start-[9999px] h-px w-px overflow-hidden">
        <label>
          website
          <input type="text" name="website" tabIndex={-1} autoComplete="off" defaultValue="" />
        </label>
      </div>
      <div className="grid gap-5 md:grid-cols-2">
        <label className="flex flex-col gap-2 font-semibold">
          {labels.name}
          <input name="name" required maxLength={120} autoComplete="name" className={field} />
        </label>
        <label className="flex flex-col gap-2 font-semibold">
          {labels.business}
          <input name="business" maxLength={160} autoComplete="organization" className={field} />
        </label>
        <label className="flex flex-col gap-2 font-semibold">
          {labels.phone}
          <input name="phone" type="tel" required maxLength={40} autoComplete="tel" dir="ltr" className={cn(field, 'text-start')} />
        </label>
        <label className="flex flex-col gap-2 font-semibold">
          {labels.email}
          <input name="email" type="email" maxLength={200} autoComplete="email" dir="ltr" className={cn(field, 'text-start')} />
        </label>
      </div>
      <label className="flex flex-col gap-2 font-semibold">
        {labels.message}
        <textarea name="message" required maxLength={4000} rows={5} className={cn(field, 'resize-y')} />
      </label>
      <div className="flex flex-wrap items-center gap-4">
        <button type="submit" disabled={state === 'sending'} aria-busy={state === 'sending'} className={cn(ctaPrimary, 'disabled:opacity-70')}>
          {state === 'sending' ? labels.sending : labels.submit}
        </button>
      </div>
      <div aria-live="polite">
        {state === 'error' && (
          <div role="alert" className="flex flex-col gap-3 rounded-xl border border-destructive/40 bg-destructive/10 p-4">
            <p className="font-semibold">{labels.error}</p>
            <a href={whatsapp.href} target="_blank" rel="noopener" className="self-start font-semibold underline underline-offset-4">
              {whatsapp.label}
            </a>
          </div>
        )}
      </div>
    </form>
  )
}
