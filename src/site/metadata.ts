import type { Metadata } from 'next'
import { LEGAL_PAGES, SITE_INDEXABLE, SITE_LEGAL_LINKED, SITE_ORIGIN, type SitePage } from '@/site/config'
import { alternatesFor, sitePath } from '@/site/paths'

/** The share image is the brand lockup alone: its alt is the lockup's (src/components/brand.tsx) */
export const OG_ALT = 'Mudrik AI'

/**
 * The head of one site page: its title and description from the copy file,
 * canonical and hreflang, Open Graph and Twitter. The image is named here, not
 * left to inheritance: a page's own openGraph replaces its parent's whole,
 * image included, so only the home page (in the image's own segment) had one.
 */
export function siteMetadata(locale: string, page: SitePage, meta: { metaTitle: string; metaDescription: string }): Metadata {
  // app/[locale]/site/opengraph-image.tsx, id "og": the lockup, so its alt is the lockup's own
  const image = { url: `/${locale}/site/opengraph-image/og`, width: 1200, height: 630, alt: OG_ALT }
  // The legal pages are never indexed while they are unlinked (SITE_LEGAL_LINKED)
  const indexable = SITE_INDEXABLE && (SITE_LEGAL_LINKED || !(Object.values(LEGAL_PAGES) as SitePage[]).includes(page))
  return {
    metadataBase: new URL(SITE_ORIGIN),
    title: meta.metaTitle,
    description: meta.metaDescription,
    alternates: alternatesFor(locale, page),
    robots: indexable ? { index: true, follow: true } : { index: false, follow: false },
    icons: { icon: '/brand/mudrik-mark.svg' },
    openGraph: {
      type: 'website',
      title: meta.metaTitle,
      description: meta.metaDescription,
      url: `${SITE_ORIGIN}${sitePath(locale, page)}`,
      locale: locale === 'ar' ? 'ar_EG' : 'en_US',
      alternateLocale: locale === 'ar' ? ['en_US'] : ['ar_EG'],
      images: [image],
    },
    twitter: { card: 'summary_large_image', title: meta.metaTitle, description: meta.metaDescription, images: [image] },
  }
}
