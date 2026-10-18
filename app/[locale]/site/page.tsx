import { setRequestLocale } from 'next-intl/server'
import ar from '../../../messages/ar.json'
import en from '../../../messages/en.json'
import { APP_ORIGIN, SITE_WIDGET_CHANNEL_ID } from '@/site/config'
import { Closing, Features, Hero, How, Paths, PricingTeaser, Problem, Try } from '@/site/components/home-sections'
import { SitePage } from '@/site/components/site-page'
import { WidgetSlot } from '@/site/components/widget-slot'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'
import { sitePath } from '@/site/paths'

type Props = { params: Promise<{ locale: string }> }

/**
 * Section 5 describes the live widget in the corner, so it exists only when
 * the widget does (the copy owner's rule: no section about a bot that isn't
 * there). SITE_PREVIEW_WIDGET_SECTION=1 at build time shows it for a local
 * review; it is never set in the deploy.
 */
const SHOW_TRY_SECTION = Boolean(SITE_WIDGET_CHANNEL_ID) || process.env.SITE_PREVIEW_WIDGET_SECTION === '1'

// The build's own time: what the hero's appointment date shows before the page has loaded
const BUILT_AT = new Date().toISOString()

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  // The home page's head carries its own headline and subtitle: the copy has no separate meta lines
  const { hero } = siteCopy(locale).home
  return siteMetadata(locale, '', { metaTitle: hero.title, metaDescription: hero.subtitle })
}

export default async function HomePage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const language = locale === 'en' ? 'en' : 'ar'
  const home = siteCopy(locale).home
  // The bot's lines in the hero are the product's own sentences, word for word
  const product = language === 'en' ? en.botReplies : ar.botReplies
  // The trial is self-serve: the product's own signup. Done-for-you is a conversation.
  const signup = `${APP_ORIGIN}/${locale}/signup`
  const contact = sitePath(locale, '/contact')
  return (
    <SitePage locale={locale} page="" wide>
      <Hero
        title={home.hero.title}
        subtitle={home.hero.subtitle}
        primary={{ label: home.hero.cta_primary, href: signup }}
        secondary={{ label: home.hero.cta_secondary, href: contact }}
        sectors={home.hero.sectors}
        demo={{
          language,
          visitor: home.hero.demo.visitor,
          bot: {
            needDetails: product.appointment.needDetails,
            missingName: product.appointment.missingName,
            phoneAsk: product.contact.phoneAsk,
            bookedConfirmed: product.appointment.bookedConfirmed,
            words: { at: product.appointment.at, am: product.appointment.am, noon: product.appointment.noon, pm: product.appointment.pm },
          },
          builtAt: BUILT_AT,
        }}
      />
      <Problem title={home.problem.title} items={home.problem.items} />
      <How title={home.how.title} steps={home.how.steps} />
      <Features title={home.features.title} items={home.features.items} />
      {SHOW_TRY_SECTION && <Try title={home.try.title} body={home.try.body} />}
      <Paths
        title={home.paths.title}
        self={{ ...home.paths.self, href: signup }}
        done={{ ...home.paths.done_for_you, href: sitePath(locale, '/for-businesses') }}
        agencies={{ label: home.paths.agencies_link, href: sitePath(locale, '/for-agencies') }}
      />
      <PricingTeaser title={home.pricing.title} body={home.pricing.body} cta={{ label: home.pricing.cta, href: sitePath(locale, '/pricing') }} />
      <Closing
        title={home.closing.title}
        body={home.closing.body}
        primary={{ label: home.closing.cta_primary, href: signup }}
        secondary={{ label: home.closing.cta_secondary, href: contact }}
      />
      <WidgetSlot />
    </SitePage>
  )
}
