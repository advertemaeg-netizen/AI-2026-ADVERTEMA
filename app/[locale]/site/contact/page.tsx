import { setRequestLocale } from 'next-intl/server'
import { SITE_EMAIL, SITE_WHATSAPP } from '@/site/config'
import { ContactForm } from '@/site/components/contact-form'
import { PageHero } from '@/site/components/page-sections'
import { SitePage } from '@/site/components/site-page'
import { siteCopy } from '@/site/copy'
import { siteMetadata } from '@/site/metadata'

type Props = { params: Promise<{ locale: string }> }

export async function generateMetadata({ params }: Props) {
  const { locale } = await params
  const meta = siteCopy(locale).meta.contact
  return siteMetadata(locale, '/contact', { metaTitle: meta.title, metaDescription: meta.description })
}

/** "+20 101 049 1850": the international form, for visitors outside Egypt too */
const whatsappDisplay = SITE_WHATSAPP.replace(/^\+20(\d{3})(\d{3})(\d{4})$/, '+20 $1 $2 $3')

/** Where every plan and the business owners' page lead: the form (sent by mail), WhatsApp and the address */
export default async function ContactPage({ params }: Props) {
  const { locale } = await params
  setRequestLocale(locale)
  const copy = siteCopy(locale).contact
  // Opens the chat with a line saying where the visitor came from, in the page's language
  const whatsapp = `https://wa.me/${SITE_WHATSAPP.replace(/\D/g, '')}?text=${encodeURIComponent(copy.whatsappPrefill)}`
  return (
    <SitePage locale={locale} page="/contact" wide>
      <PageHero title={copy.hero.title} body={copy.hero.body} />
      <div className="grid gap-10 lg:grid-cols-[1.6fr_1fr] lg:items-start">
        <ContactForm locale={locale} labels={copy.form} whatsapp={{ label: copy.direct.whatsapp, href: whatsapp }} />
        <section className="site-panel-quiet flex flex-col gap-5 p-7 md:p-8">
          <h2 className="text-2xl font-bold">{copy.direct.title}</h2>
          <dl className="flex flex-col gap-5">
            <div className="flex flex-col gap-1">
              <dt className="text-sm font-semibold">{copy.direct.whatsapp}</dt>
              <dd>
                <a href={whatsapp} target="_blank" rel="noopener" dir="ltr" className="text-xl font-bold underline underline-offset-4">
                  {whatsappDisplay}
                </a>
              </dd>
            </div>
            <div className="flex flex-col gap-1">
              <dt className="text-sm font-semibold">{copy.direct.email}</dt>
              <dd>
                <a href={`mailto:${SITE_EMAIL}`} dir="ltr" className="text-xl font-bold underline underline-offset-4">
                  {SITE_EMAIL}
                </a>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </SitePage>
  )
}
