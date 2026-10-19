import { setRequestLocale } from 'next-intl/server'
import { APP_ORIGIN } from '@/site/config'
import { Closing } from '@/site/components/home-sections'
import { DayTimeline, NotePanel, PageHero } from '@/site/components/page-sections'
import { SitePage } from '@/site/components/site-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  const meta = siteCopy(locale).meta.business
  return siteMetadata(locale, '/for-businesses', { metaTitle: meta.title, metaDescription: meta.description })
}

/** Business owners: creating an account is self-serve, so both calls are the product's own signup */
export default async function ForBusinessesPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = siteCopy(locale).business
  const signup = { label: copy.hero.cta, href: `${APP_ORIGIN}/${locale}/signup` }
  return (
    <SitePage locale={locale} page="/for-businesses" wide>
      <PageHero title={copy.hero.title} body={copy.hero.body} cta={signup} />
      <DayTimeline title={copy.day.title} items={copy.day.items} />
      <NotePanel title={copy.whatYouGive.title} body={copy.whatYouGive.body} note={copy.whatYouGive.note} />
      <NotePanel title={copy.limits.title} body={copy.limits.body} note={copy.limits.note} emphasis />
      <Closing title={copy.closing.title} body={copy.closing.body} primary={signup} />
    </SitePage>
  )
}
