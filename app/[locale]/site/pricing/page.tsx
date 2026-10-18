import Link from 'next/link'
import { setRequestLocale } from 'next-intl/server'
import { SiteHero, SitePage } from '@/site/components/site-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'
import { sitePath } from '@/site/paths'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  return siteMetadata(locale, '/pricing', siteCopy(locale).pages.pricing)
}

/** Named tiers, no numbers: every tier ends in the contact page */
export default async function PricingPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = siteCopy(locale).pages.pricing
  return (
    <SitePage locale={locale} page="/pricing">
      <SiteHero title={copy.title} intro={copy.intro} />
      <ul className="grid gap-6 md:grid-cols-3">
        {copy.tiers.map((tier, i) => (
          <li key={i} className="glass-solid flex flex-col gap-3 rounded-xl p-6">
            <h2 className="text-xl font-semibold">{tier.name}</h2>
            <p className="flex-1">{tier.summary}</p>
            <Link href={sitePath(locale, '/contact')} className="self-start rounded-md bg-primary px-4 py-2 text-primary-foreground">
              {tier.cta}
            </Link>
          </li>
        ))}
      </ul>
    </SitePage>
  )
}
