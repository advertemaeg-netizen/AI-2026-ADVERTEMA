import { SITE_ORIGIN, type SitePage } from '@/site/config'

/** The site's own URL for a page in a locale (the visitor's, not the internal /site segment) */
export const sitePath = (locale: string, page: SitePage) => `/${locale}${page}`

/** The same page in the other language */
export const otherLocale = (locale: string) => (locale === 'ar' ? 'en' : 'ar')

/** Canonical and hreflang alternates for a page; Arabic is the default */
export function alternatesFor(locale: string, page: SitePage) {
  return {
    canonical: `${SITE_ORIGIN}${sitePath(locale, page)}`,
    languages: {
      ar: `${SITE_ORIGIN}${sitePath('ar', page)}`,
      en: `${SITE_ORIGIN}${sitePath('en', page)}`,
      'x-default': `${SITE_ORIGIN}${sitePath('ar', page)}`,
    },
  }
}
