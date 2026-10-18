import type { Metadata } from 'next'
import { SITE_INDEXABLE, SITE_ORIGIN, type SitePage } from '@/site/config'
import { siteCopy } from '@/site/copy'
import { alternatesFor, sitePath } from '@/site/paths'

/**
 * The head of one site page: its title and description from the copy file,
 * canonical and hreflang, Open Graph and Twitter. The image is named here, not
 * left to inheritance: a page's own openGraph replaces its parent's whole,
 * image included, so only the home page (in the image's own segment) had one.
 */
export function siteMetadata(locale: string, page: SitePage, meta: { metaTitle: string; metaDescription: string }): Metadata {
  const copy = siteCopy(locale)
  // app/[locale]/site/opengraph-image.tsx, id "og"
  const image = { url: `/${locale}/site/opengraph-image/og`, width: 1200, height: 630, alt: copy.meta.ogAlt }
  return {
    metadataBase: new URL(SITE_ORIGIN),
    title: meta.metaTitle,
    description: meta.metaDescription,
    applicationName: copy.meta.siteName,
    alternates: alternatesFor(locale, page),
    robots: SITE_INDEXABLE ? { index: true, follow: true } : { index: false, follow: false },
    icons: { icon: '/brand/mudrik-mark.svg' },
    openGraph: {
      type: 'website',
      siteName: copy.meta.siteName,
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
