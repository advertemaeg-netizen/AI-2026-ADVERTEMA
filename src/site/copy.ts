import 'server-only'
import ar from '../../messages/site/ar.json'
import en from '../../messages/site/en.json'

/**
 * Every word on the site comes from messages/site/{ar,en}.json, which the
 * copy owner writes: replacing the copy is a change to those two files and
 * nothing else. Until then each value is its own key name, so a page shows
 * where each piece of text goes. The two files must have the same keys
 * (tests/site/copy.test.ts checks it).
 *
 * Kept apart from the product's messages on purpose: the product's
 * NextIntlClientProvider would otherwise ship the whole site's copy to every
 * dashboard page, and the site has to lift out on its own later.
 */

export type SiteCopy = typeof en
export type SiteLocale = 'ar' | 'en'

const COPY: Record<SiteLocale, SiteCopy> = { ar, en }

export function siteCopy(locale: string): SiteCopy {
  return COPY[locale === 'en' ? 'en' : 'ar']
}
