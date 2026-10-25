import { setRequestLocale } from 'next-intl/server'
import ar from '../../../messages/ar.json'
import en from '../../../messages/en.json'
import { APP_ORIGIN, SITE_WIDGET_CHANNEL_ID } from '@/site/config'
import { ChannelsSection, Closing, Features, Hero, How, Paths, PricingTeaser, Problem, ProblemSection, Try } from '@/site/components/home-sections'
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
  // Its own lines, not the hero's: a search result and a shared link say what the product is
  const { home } = siteCopy(locale).meta
  return siteMetadata(locale, '', { metaTitle: home.title, metaDescription: home.description })
}

export default async function HomePage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const language = locale === 'en' ? 'en' : 'ar'
  const home = siteCopy(locale).home
  // The bot's lines in the hero are the product's own sentences, word for word
  const product = language === 'en' ? en.botReplies : ar.botReplies
  // Creating an account is self-serve: the product's own signup. Done-for-you is a conversation.
  const signup = `${APP_ORIGIN}/${locale}/signup`
  const contact = sitePath(locale, '/contact')
  return (
    <SitePage locale={locale} page="" wide>
      <Hero
        title={home.hero.title}
        subtitle={home.hero.subtitle}
        primary={{ label: home.hero.cta_primary, href: signup }}
        secondary={{ label: home.hero.cta_secondary, href: contact }}
        demo={{
          language,
          label: home.hero.demo.label,
          // The copy numbers the visitor's lines 0, 2, 4: the bot's 1, 3, 5 are the product's
          visitor: [home.hero.demo.messages['0'].text, home.hero.demo.messages['2'].text, home.hero.demo.messages['4'].text],
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
      {/* The sections brief of 25 October 2026 (home.sections.*) exists in Arabic only so far: the
          English page keeps the earlier sections until its copy arrives (en.json holds key names). */}
      {language === 'ar' ? (
        <>
          <ProblemSection {...home.sections.problem} />
          <How
            className="site-surface py-16 md:py-20"
            title={home.sections.how.title}
            steps={home.sections.how.steps.map((step) => ({ label: step.title, body: step.body }))}
          />
        </>
      ) : (
        <>
          <Problem title={home.problem.title} items={home.problem.items} />
          <How title={home.how.title} steps={home.how.steps} />
        </>
      )}
      <Features title={home.features.title} items={home.features.items} />
      {language === 'ar' && <ChannelsSection {...home.sections.channels} />}
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
