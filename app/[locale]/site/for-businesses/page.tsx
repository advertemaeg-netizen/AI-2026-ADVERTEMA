import Link from 'next/link'
import { setRequestLocale } from 'next-intl/server'
import { SiteHero, SitePage, SiteSections } from '@/site/components/site-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'
import { sitePath } from '@/site/paths'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  return siteMetadata(locale, '/for-businesses', siteCopy(locale).pages.forBusinesses)
}

/** Business owners (any service business): Mudrik is set up for them, as a paid package, so the way in is a conversation */
export default async function ForBusinessesPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = siteCopy(locale).pages.forBusinesses
  return (
    <SitePage locale={locale} page="/for-businesses">
      <SiteHero title={copy.title} intro={copy.intro} />
      <SiteSections sections={copy.sections} />
      <Link href={sitePath(locale, '/contact')} className="self-start rounded-md bg-primary px-4 py-2 text-primary-foreground">
        {copy.cta}
      </Link>
    </SitePage>
  )
}
