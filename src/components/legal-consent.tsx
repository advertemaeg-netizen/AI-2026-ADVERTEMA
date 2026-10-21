'use client'

import { useEffect, useState } from 'react'
import { useLocale, useTranslations } from 'next-intl'
import { Checkbox } from '@/components/ui/checkbox'
import { LEGAL_LINKED } from '@/lib/legal-linked'
import { createClient } from '@/lib/supabase/client'
import { LEGAL_PAGES, SITE_ORIGIN } from '@/site/config'

/**
 * "I agree to the Terms of Service and the Privacy Policy" at signup: a
 * deliberate tick, never pre-ticked, and the signup does not go ahead without
 * it. The versions the person was shown are sent with the signup (metadata
 * accepted_legal) and recorded on their profile once (the trigger
 * record_legal_acceptance), as evidence of what they agreed to.
 *
 * On with LEGAL_LINKED. Off, nothing is shown and nothing is sent: the signup
 * as it was before the reviewed texts were published.
 */
export function useLegalConsent() {
  const locale = useLocale() === 'en' ? 'en' : 'ar'
  const [accepted, setAccepted] = useState(false)
  const [versions, setVersions] = useState<{ terms: string; privacy: string } | null>(null)

  useEffect(() => {
    if (!LEGAL_LINKED) return
    let live = true
    createClient()
      .from('legal_versions')
      .select('id, document, version')
      .eq('locale', locale)
      .order('version', { ascending: false })
      .then(({ data }) => {
        if (!live || !data) return
        const latest = (document: string) => data.find((v) => v.document === document)?.id
        const terms = latest('terms')
        const privacy = latest('privacy')
        if (terms && privacy) setVersions({ terms, privacy })
      })
    return () => {
      live = false
    }
  }, [locale])

  return {
    enabled: LEGAL_LINKED,
    accepted,
    setAccepted,
    /** Whether the signup may go ahead: always when off; on, only ticked and with the versions known */
    ready: !LEGAL_LINKED || (accepted && versions !== null),
    /** What the signup sends: nothing when off */
    metadata: LEGAL_LINKED && accepted && versions ? { accepted_legal: versions } : {},
    locale,
  }
}

/** The checkbox, its label's two phrases linking to the documents (new tab: a half-filled form isn't lost) */
export function LegalConsentField({
  consent,
  invalid,
}: {
  consent: ReturnType<typeof useLegalConsent>
  invalid: boolean
}) {
  const t = useTranslations('auth.signup.consent')
  if (!consent.enabled) return null
  // "I agree to the [Terms of Service] and the [Privacy Policy]": the bracketed phrases, in that order
  const targets = [`${SITE_ORIGIN}/${consent.locale}${LEGAL_PAGES.terms}`, `${SITE_ORIGIN}/${consent.locale}${LEGAL_PAGES.privacy}`]
  let link = 0
  const label = t('label')
    .split(/(\[[^\]]+\])/)
    .map((part, i) =>
      part.startsWith('[') && part.endsWith(']') ? (
        <a key={i} href={targets[link++]} target="_blank" rel="noopener" className="font-medium underline underline-offset-4">
          {part.slice(1, -1)}
        </a>
      ) : (
        part
      )
    )
  return (
    <div className="space-y-1.5">
      <div className="flex items-start gap-2.5">
        <Checkbox
          id="legalConsent"
          checked={consent.accepted}
          onCheckedChange={(value) => consent.setAccepted(value === true)}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? 'legalConsentError' : undefined}
          className="mt-0.5"
        />
        <label htmlFor="legalConsent" className="text-sm leading-relaxed">
          {label}
        </label>
      </div>
      {invalid && (
        <p id="legalConsentError" role="alert" className="text-sm text-destructive">
          {t('error')}
        </p>
      )}
    </div>
  )
}
