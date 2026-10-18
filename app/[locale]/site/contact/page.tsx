import { setRequestLocale } from 'next-intl/server'
import { SiteHero, SitePage } from '@/site/components/site-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  return siteMetadata(locale, '/contact', siteCopy(locale).pages.contact)
}

/** Where every tier and the business owners' page lead. Channels are copy (label and value), not a form: there is no backend for one yet. */
export default async function ContactPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = siteCopy(locale).pages.contact
  return (
    <SitePage locale={locale} page="/contact">
      <SiteHero title={copy.title} intro={copy.intro} />
      <dl className="grid gap-4 sm:grid-cols-2">
        {copy.channels.map((channel, i) => (
          <div key={i} className="flex flex-col gap-1">
            <dt className="text-sm">{channel.label}</dt>
            <dd className="text-lg font-semibold">{channel.value}</dd>
          </div>
        ))}
      </dl>
    </SitePage>
  )
}
