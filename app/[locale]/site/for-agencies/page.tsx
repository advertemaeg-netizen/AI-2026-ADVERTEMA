import { setRequestLocale } from 'next-intl/server'
import { APP_ORIGIN } from '@/site/config'
import { SiteHero, SitePage, SiteSections } from '@/site/components/site-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  return siteMetadata(locale, '/for-agencies', siteCopy(locale).pages.forAgencies)
}

/** Agencies: self-serve, so the way in is the product's own signup */
export default async function ForAgenciesPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = siteCopy(locale).pages.forAgencies
  return (
    <SitePage locale={locale} page="/for-agencies">
      <SiteHero title={copy.title} intro={copy.intro} />
      <SiteSections sections={copy.sections} />
      <a href={`${APP_ORIGIN}/${locale}/signup`} className="self-start rounded-md bg-primary px-4 py-2 text-primary-foreground">
        {copy.cta}
      </a>
    </SitePage>
  )
}
