import { setRequestLocale } from 'next-intl/server'
import { APP_ORIGIN } from '@/site/config'
import { Closing, Problem } from '@/site/components/home-sections'
import { PageHero, Upfront } from '@/site/components/page-sections'
import { SitePage } from '@/site/components/site-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  const meta = siteCopy(locale).meta.agency
  return siteMetadata(locale, '/for-agencies', { metaTitle: meta.title, metaDescription: meta.description })
}

/**
 * Agencies: self-serve, so the way in is the product's own signup. The
 * upfront section says Mudrik runs under its own name, not the agency's: on
 * purpose, at full size (no white-label is built, and promising it costs a
 * refund later).
 */
export default async function ForAgenciesPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = siteCopy(locale).agency
  const signup = { label: copy.hero.cta, href: `${APP_ORIGIN}/${locale}/signup` }
  return (
    <SitePage locale={locale} page="/for-agencies" wide>
      <PageHero title={copy.hero.title} body={copy.hero.body} cta={signup} />
      <Problem title={copy.why.title} items={copy.why.items} />
      <Upfront title={copy.honest.title} body={copy.honest.body} />
      <Closing title={copy.closing.title} body={copy.closing.body} primary={signup} />
    </SitePage>
  )
}
