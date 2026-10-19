import { setRequestLocale } from 'next-intl/server'
import { Pair, PageHero, Tiers } from '@/site/components/page-sections'
import { SitePage } from '@/site/components/site-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'
import { sitePath } from '@/site/paths'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  // No meta lines in the copy for this page: its own headline and lead
  const { hero } = siteCopy(locale).pricing
  return siteMetadata(locale, '/pricing', { metaTitle: hero.title, metaDescription: hero.body })
}

/** Named plans and no prices, by Ahmed's decision: every plan ends in the contact page */
export default async function PricingPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = siteCopy(locale).pricing
  return (
    <SitePage locale={locale} page="/pricing" wide>
      <PageHero title={copy.hero.title} body={copy.hero.body} />
      <Tiers tiers={copy.tiers} cta={{ label: copy.cta, href: sitePath(locale, '/contact') }} />
      <Pair
        items={[
          { label: copy.setup.title, body: copy.setup.body },
          { label: copy.trial.title, body: copy.trial.body },
        ]}
      />
    </SitePage>
  )
}
